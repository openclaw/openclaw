const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const PORT = 3007;
const POLL_INTERVAL_MS = 1000;
const APPLESCRIPT_TIMEOUT_MS = 30000;
const READ_APPLESCRIPT_TIMEOUT_MS = 15000;
const DEFAULT_UPCOMING_DAYS = 7;
const DEFAULT_SEARCH_DAYS = 30;
const LOG_PREFIX = '[calendar-service]';
const RECORD_SEPARATOR = String.fromCharCode(30);
const FIELD_SEPARATOR = String.fromCharCode(31);
const HOME_DIR = process.env.HOME || os.homedir();
const DATA_DIR = path.join(HOME_DIR, '.openclaw', 'workspace', 'calendar');
const REQUEST_FILE = path.join(DATA_DIR, 'calendar-request.json');
const RESPONSE_FILE = path.join(DATA_DIR, 'calendar-response.json');

let lastProcessedMtimeMs = 0;
let isProcessing = false;
let hasPendingRun = false;
const eventCalendarCache = new Map();

fs.mkdirSync(DATA_DIR, { recursive: true });

function log(message) {
  console.log(`${LOG_PREFIX} ${message}`);
}

function logError(message) {
  console.error(`${LOG_PREFIX} ${message}`);
}

function writeResponse(payload) {
  const tempFile = RESPONSE_FILE + '.tmp';
  fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2));
  fs.renameSync(tempFile, RESPONSE_FILE);
}

function successResponse(action, data) {
  return {
    success: true,
    action,
    data,
    responded_at: new Date().toISOString()
  };
}

function errorResponse(action, error) {
  return {
    success: false,
    action: action || null,
    error: error instanceof Error ? error.message : String(error),
    responded_at: new Date().toISOString()
  };
}

function runAppleScript(scriptLines, args = [], options = {}) {
  const timeoutMs = options.timeoutMs || APPLESCRIPT_TIMEOUT_MS;
  const commandArgs = [];
  for (const line of scriptLines) {
    commandArgs.push('-e', line);
  }
  for (const arg of args) {
    commandArgs.push(String(arg));
  }

  return new Promise((resolve, reject) => {
    execFile('osascript', commandArgs, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const message = stderr && stderr.trim()
          ? stderr.trim()
          : err.killed
            ? `AppleScript timed out after ${timeoutMs}ms`
            : (err.message || 'AppleScript failed').trim();
        reject(new Error(message));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatLocalDateTime(date) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('-') + 'T' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join(':');
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

function isDateOnlyString(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseDateInput(value, options = {}) {
  const { endExclusiveForDateOnly = false } = options;

  if (!value) {
    throw new Error('Date value is required');
  }

  if (isDateOnlyString(value)) {
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(year, month - 1, day, 0, 0, 0, 0);
    if (endExclusiveForDateOnly) {
      parsed.setDate(parsed.getDate() + 1);
    }
    return parsed;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  return parsed;
}

function formatAppleScriptDate(date) {
  const monthNames = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December'
  ];
  const hours24 = date.getHours();
  const hours12 = hours24 % 12 || 12;
  const meridiem = hours24 >= 12 ? 'PM' : 'AM';
  return `${monthNames[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()} ${hours12}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${meridiem}`;
}

function eventDateFromParts(year, month, day, seconds) {
  const date = new Date(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0);
  date.setSeconds(Number(seconds));
  return date;
}

function parseEventRecord(record) {
  const parts = record.split(FIELD_SEPARATOR);
  if (parts.length < 14) {
    throw new Error(`Unexpected event payload with ${parts.length} fields`);
  }

  const start = eventDateFromParts(parts[6], parts[7], parts[8], parts[9]);
  const end = eventDateFromParts(parts[10], parts[11], parts[12], parts[13]);

  const event = {
    title: parts[0] || '',
    calendar: parts[1] || '',
    location: parts[2] || null,
    notes: parts[3] || null,
    allDay: parts[4] === 'true',
    uid: parts[5] || '',
    startDate: formatLocalDateTime(start),
    endDate: formatLocalDateTime(end),
    _startMs: start.getTime(),
    _endMs: end.getTime()
  };

  if (event.uid && event.calendar) {
    eventCalendarCache.set(event.uid, event.calendar);
  }

  return event;
}

function sortEvents(events) {
  return events
    .slice()
    .sort((left, right) => left._startMs - right._startMs || left._endMs - right._endMs || left.title.localeCompare(right.title))
    .map(({ _startMs, _endMs, ...event }) => event);
}

function groupEventsByDate(events) {
  const grouped = new Map();

  for (const event of events) {
    const key = event.startDate.slice(0, 10);
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(event);
  }

  return Array.from(grouped.entries()).map(([date, dayEvents]) => ({
    date,
    events: dayEvents
  }));
}

function parseEventOutput(output) {
  if (!output) {
    return [];
  }

  return output
    .split(RECORD_SEPARATOR)
    .filter(Boolean)
    .map(parseEventRecord);
}

function eventReadScript() {
  return [
    'on safeText(value)',
    '  if value is missing value then return ""',
    '  return value as text',
    'end safeText',
    'on run argv',
    '  set startDateValue to date (item 1 of argv)',
    '  set endDateValue to date (item 2 of argv)',
    '  set calendarFilter to ""',
    '  if (count of argv) > 2 then set calendarFilter to item 3 of argv',
    '  set recordDelimiter to ASCII character 30',
    '  set fieldDelimiter to ASCII character 31',
    '  set output to ""',
    '  tell application "Calendar"',
    '    set targetCalendars to calendars',
    '    if calendarFilter is not "" then',
    '      set targetCalendars to every calendar whose name is calendarFilter',
    '    end if',
    '    repeat with cal in targetCalendars',
    '      set eventList to (every event of cal whose start date >= startDateValue and start date < endDateValue)',
    '      repeat with evt in eventList',
    '        set evtStart to start date of evt',
    '        set evtEnd to end date of evt',
    '        set output to output & recordDelimiter & (my safeText(summary of evt)) & fieldDelimiter & (name of cal as text) & fieldDelimiter & (my safeText(location of evt)) & fieldDelimiter & (my safeText(description of evt)) & fieldDelimiter & ((allday event of evt) as text) & fieldDelimiter & (uid of evt as text) & fieldDelimiter & (year of evtStart as text) & fieldDelimiter & ((month of evtStart as integer) as text) & fieldDelimiter & (day of evtStart as text) & fieldDelimiter & (time of evtStart as text) & fieldDelimiter & (year of evtEnd as text) & fieldDelimiter & ((month of evtEnd as integer) as text) & fieldDelimiter & (day of evtEnd as text) & fieldDelimiter & (time of evtEnd as text)',
    '      end repeat',
    '    end repeat',
    '  end tell',
    '  return output',
    'end run'
  ];
}

function calendarListScript() {
  return [
    'on run',
    '  set recordDelimiter to ASCII character 30',
    '  set output to ""',
    '  tell application "Calendar"',
    '    repeat with cal in calendars',
    '      set output to output & recordDelimiter & (name of cal as text)',
    '    end repeat',
    '  end tell',
    '  return output',
    'end run'
  ];
}

function eventWriteScriptForCreate() {
  return [
    'on run argv',
    '  set fieldDelimiter to ASCII character 31',
    '  set eventTitle to item 1 of argv',
    '  set startDateValue to date (item 2 of argv)',
    '  set endDateValue to date (item 3 of argv)',
    '  set calendarName to item 4 of argv',
    '  set eventLocation to item 5 of argv',
    '  set eventNotes to item 6 of argv',
    '  set isAllDay to ((item 7 of argv) is "true")',
    '  tell application "Calendar"',
    '    if calendarName is "" then',
    '      set targetCalendar to first calendar',
    '    else',
    '      set matchingCalendars to every calendar whose name is calendarName',
    '      if (count of matchingCalendars) is 0 then error "Calendar not found: " & calendarName',
    '      set targetCalendar to item 1 of matchingCalendars',
    '    end if',
    '    tell targetCalendar',
    '      set newEvent to make new event with properties {summary:eventTitle, start date:startDateValue, end date:endDateValue, location:eventLocation, description:eventNotes, allday event:isAllDay}',
    '    end tell',
    '    set evtStart to start date of newEvent',
    '    set evtEnd to end date of newEvent',
    '    return (uid of newEvent as text) & fieldDelimiter & (summary of newEvent as text) & fieldDelimiter & (name of targetCalendar as text) & fieldDelimiter & (year of evtStart as text) & fieldDelimiter & ((month of evtStart as integer) as text) & fieldDelimiter & (day of evtStart as text) & fieldDelimiter & (time of evtStart as text) & fieldDelimiter & (year of evtEnd as text) & fieldDelimiter & ((month of evtEnd as integer) as text) & fieldDelimiter & (day of evtEnd as text) & fieldDelimiter & (time of evtEnd as text)',
    '  end tell',
    'end run'
  ];
}

function eventWriteScriptForUpdate() {
  return [
    'on safeText(value)',
    '  if value is missing value then return ""',
    '  return value as text',
    'end safeText',
    'on run argv',
    '  set fieldDelimiter to ASCII character 31',
    '  set targetUid to item 1 of argv',
    '  set shouldSetTitle to ((item 2 of argv) is "true")',
    '  set newTitle to item 3 of argv',
    '  set shouldSetStart to ((item 4 of argv) is "true")',
    '  set newStartText to item 5 of argv',
    '  set shouldSetEnd to ((item 6 of argv) is "true")',
    '  set newEndText to item 7 of argv',
    '  set shouldSetLocation to ((item 8 of argv) is "true")',
    '  set newLocation to item 9 of argv',
    '  set shouldSetNotes to ((item 10 of argv) is "true")',
    '  set newNotes to item 11 of argv',
    '  set preferredCalendarName to item 12 of argv',
    '  tell application "Calendar"',
    '    set targetEvent to missing value',
    '    set targetCalendarName to ""',
    '    set targetCalendars to calendars',
    '    if preferredCalendarName is not "" then',
    '      set targetCalendars to every calendar whose name is preferredCalendarName',
    '    end if',
    '    repeat with cal in targetCalendars',
    '      set matchingEvents to every event of cal whose uid = targetUid',
    '      if (count of matchingEvents) > 0 then',
    '        set targetEvent to item 1 of matchingEvents',
    '        set targetCalendarName to name of cal',
    '        exit repeat',
    '      end if',
    '    end repeat',
    '    if targetEvent is missing value and preferredCalendarName is not "" then',
    '      repeat with cal in calendars',
    '        set matchingEvents to every event of cal whose uid = targetUid',
    '        if (count of matchingEvents) > 0 then',
    '          set targetEvent to item 1 of matchingEvents',
    '          set targetCalendarName to name of cal',
    '          exit repeat',
    '        end if',
    '      end repeat',
    '    end if',
    '    if targetEvent is missing value then error "Event not found for uid " & targetUid',
    '    if shouldSetTitle then set summary of targetEvent to newTitle',
    '    if shouldSetStart then set start date of targetEvent to date newStartText',
    '    if shouldSetEnd then set end date of targetEvent to date newEndText',
    '    if shouldSetLocation then set location of targetEvent to newLocation',
    '    if shouldSetNotes then set description of targetEvent to newNotes',
    '    set evtStart to start date of targetEvent',
    '    set evtEnd to end date of targetEvent',
    '    return (uid of targetEvent as text) & fieldDelimiter & (summary of targetEvent as text) & fieldDelimiter & targetCalendarName & fieldDelimiter & (year of evtStart as text) & fieldDelimiter & ((month of evtStart as integer) as text) & fieldDelimiter & (day of evtStart as text) & fieldDelimiter & (time of evtStart as text) & fieldDelimiter & (year of evtEnd as text) & fieldDelimiter & ((month of evtEnd as integer) as text) & fieldDelimiter & (day of evtEnd as text) & fieldDelimiter & (time of evtEnd as text) & fieldDelimiter & (my safeText(location of targetEvent)) & fieldDelimiter & (my safeText(description of targetEvent)) & fieldDelimiter & ((allday event of targetEvent) as text)',
    '  end tell',
    'end run'
  ];
}

function eventWriteScriptForDelete() {
  return [
    'on run argv',
    '  set targetUid to item 1 of argv',
    '  set preferredCalendarName to item 2 of argv',
    '  set deletedCount to 0',
    '  tell application "Calendar"',
    '    set targetCalendars to calendars',
    '    if preferredCalendarName is not "" then',
    '      set targetCalendars to every calendar whose name is preferredCalendarName',
    '    end if',
    '    repeat with cal in targetCalendars',
    '      set matchingEvents to every event of cal whose uid = targetUid',
    '      repeat with evt in matchingEvents',
    '        delete evt',
    '        set deletedCount to deletedCount + 1',
    '      end repeat',
    '    end repeat',
    '    if deletedCount is 0 and preferredCalendarName is not "" then',
    '      repeat with cal in calendars',
    '        set matchingEvents to every event of cal whose uid = targetUid',
    '        repeat with evt in matchingEvents',
    '          delete evt',
    '          set deletedCount to deletedCount + 1',
    '        end repeat',
    '      end repeat',
    '    end if',
    '  end tell',
    '  if deletedCount is 0 then error "Event not found for uid " & targetUid',
    '  return targetUid',
    'end run'
  ];
}

async function getEventsInRange(startDate, endDate, calendarName) {
  const output = await runAppleScript(eventReadScript(), [
    formatAppleScriptDate(startDate),
    formatAppleScriptDate(endDate),
    calendarName
  ], { timeoutMs: READ_APPLESCRIPT_TIMEOUT_MS });
  return sortEvents(parseEventOutput(output));
}

async function listCalendarNames() {
  const output = await runAppleScript(calendarListScript());
  return output.split(RECORD_SEPARATOR).filter(Boolean);
}

async function getEventsAcrossCalendars(startDate, endDate) {
  const calendarNames = await listCalendarNames();
  const allEvents = [];
  const skippedCalendars = [];

  for (const calendarName of calendarNames) {
    try {
      const events = await getEventsInRange(startDate, endDate, calendarName);
      allEvents.push(...events);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(`skipping calendar "${calendarName}": ${message}`);
      skippedCalendars.push({
        calendar: calendarName,
        error: message
      });
    }
  }

  return {
    events: sortEvents(allEvents),
    skipped_calendars: skippedCalendars
  };
}

function serializeCreatedOrUpdatedEvent(rawOutput, includeExtendedFields) {
  const parts = rawOutput.split(FIELD_SEPARATOR);
  if (includeExtendedFields) {
    if (parts.length < 14) {
      throw new Error('Unexpected update response payload');
    }
    const start = eventDateFromParts(parts[3], parts[4], parts[5], parts[6]);
    const end = eventDateFromParts(parts[7], parts[8], parts[9], parts[10]);
    const event = {
      uid: parts[0],
      title: parts[1],
      calendar: parts[2],
      startDate: formatLocalDateTime(start),
      endDate: formatLocalDateTime(end),
      location: parts[11] || null,
      notes: parts[12] || null,
      allDay: parts[13] === 'true'
    };
    if (event.uid && event.calendar) {
      eventCalendarCache.set(event.uid, event.calendar);
    }
    return event;
  }

  if (parts.length < 11) {
    throw new Error('Unexpected create response payload');
  }

  const start = eventDateFromParts(parts[3], parts[4], parts[5], parts[6]);
  const end = eventDateFromParts(parts[7], parts[8], parts[9], parts[10]);
  const event = {
    uid: parts[0],
    title: parts[1],
    calendar: parts[2],
    startDate: formatLocalDateTime(start),
    endDate: formatLocalDateTime(end)
  };
  if (event.uid && event.calendar) {
    eventCalendarCache.set(event.uid, event.calendar);
  }
  return event;
}

function requireField(request, fieldName) {
  if (request[fieldName] === undefined || request[fieldName] === null || request[fieldName] === '') {
    throw new Error(`${fieldName} is required`);
  }
  return request[fieldName];
}

async function handleToday() {
  const start = startOfDay(new Date());
  const end = addDays(start, 1);
  const { events, skipped_calendars } = await getEventsAcrossCalendars(start, end);
  return {
    date: formatLocalDateTime(start).slice(0, 10),
    events,
    skipped_calendars
  };
}

async function handleUpcoming(request) {
  const requestedDays = request.days === undefined ? DEFAULT_UPCOMING_DAYS : Number(request.days);
  if (!Number.isInteger(requestedDays) || requestedDays <= 0) {
    throw new Error('days must be a positive integer');
  }

  const start = startOfDay(new Date());
  const end = addDays(start, requestedDays);
  const { events, skipped_calendars } = await getEventsAcrossCalendars(start, end);
  return {
    days: requestedDays,
    events,
    grouped_by_date: groupEventsByDate(events),
    skipped_calendars
  };
}

async function handleListEvents(request) {
  const startDate = parseDateInput(requireField(request, 'start_date'));
  const endDate = parseDateInput(requireField(request, 'end_date'), { endExclusiveForDateOnly: isDateOnlyString(request.end_date) });

  if (endDate <= startDate) {
    throw new Error('end_date must be after start_date');
  }

  const result = request.calendar
    ? { events: await getEventsInRange(startDate, endDate, request.calendar), skipped_calendars: [] }
    : await getEventsAcrossCalendars(startDate, endDate);
  return {
    start_date: formatLocalDateTime(startDate),
    end_date: formatLocalDateTime(endDate),
    calendar: request.calendar || null,
    events: result.events,
    skipped_calendars: result.skipped_calendars
  };
}

async function handleCreateEvent(request) {
  const title = String(requireField(request, 'title'));
  const startDate = parseDateInput(requireField(request, 'start_date'));
  const endDate = parseDateInput(requireField(request, 'end_date'));

  if (endDate <= startDate) {
    throw new Error('end_date must be after start_date');
  }

  const output = await runAppleScript(eventWriteScriptForCreate(), [
    title,
    formatAppleScriptDate(startDate),
    formatAppleScriptDate(endDate),
    request.calendar || '',
    request.location || '',
    request.notes || '',
    request.all_day === true ? 'true' : 'false'
  ]);

  return serializeCreatedOrUpdatedEvent(output, false);
}

async function handleUpdateEvent(request) {
  const uid = String(requireField(request, 'uid'));
  const hasTitle = Object.prototype.hasOwnProperty.call(request, 'title');
  const hasStartDate = Object.prototype.hasOwnProperty.call(request, 'start_date');
  const hasEndDate = Object.prototype.hasOwnProperty.call(request, 'end_date');
  const hasLocation = Object.prototype.hasOwnProperty.call(request, 'location');
  const hasNotes = Object.prototype.hasOwnProperty.call(request, 'notes');

  if (!hasTitle && !hasStartDate && !hasEndDate && !hasLocation && !hasNotes) {
    throw new Error('At least one field to update is required');
  }

  const startDate = hasStartDate ? parseDateInput(request.start_date) : null;
  const endDate = hasEndDate ? parseDateInput(request.end_date) : null;

  if (startDate && endDate && endDate <= startDate) {
    throw new Error('end_date must be after start_date');
  }

  const output = await runAppleScript(eventWriteScriptForUpdate(), [
    uid,
    hasTitle ? 'true' : 'false',
    hasTitle ? String(request.title || '') : '',
    hasStartDate ? 'true' : 'false',
    hasStartDate ? formatAppleScriptDate(startDate) : '',
    hasEndDate ? 'true' : 'false',
    hasEndDate ? formatAppleScriptDate(endDate) : '',
    hasLocation ? 'true' : 'false',
    hasLocation ? String(request.location || '') : '',
    hasNotes ? 'true' : 'false',
    hasNotes ? String(request.notes || '') : '',
    request.calendar || eventCalendarCache.get(uid) || ''
  ]);

  return serializeCreatedOrUpdatedEvent(output, true);
}

async function handleDeleteEvent(request) {
  const uid = String(requireField(request, 'uid'));
  const deletedUid = await runAppleScript(eventWriteScriptForDelete(), [
    uid,
    request.calendar || eventCalendarCache.get(uid) || ''
  ]);
  eventCalendarCache.delete(uid);
  return {
    deleted: true,
    uid: deletedUid || uid
  };
}

async function handleSearchEvents(request) {
  const query = String(requireField(request, 'query')).toLowerCase();
  const startDate = request.start_date
    ? parseDateInput(request.start_date)
    : startOfDay(new Date());
  const endDate = request.end_date
    ? parseDateInput(request.end_date, { endExclusiveForDateOnly: isDateOnlyString(request.end_date) })
    : addDays(startOfDay(new Date()), DEFAULT_SEARCH_DAYS);

  if (endDate <= startDate) {
    throw new Error('end_date must be after start_date');
  }

  const { events, skipped_calendars } = await getEventsAcrossCalendars(startDate, endDate);
  const matches = events.filter((event) => event.title.toLowerCase().includes(query));
  return {
    query: request.query,
    start_date: formatLocalDateTime(startDate),
    end_date: formatLocalDateTime(endDate),
    events: matches,
    skipped_calendars
  };
}

async function dispatchRequest(request) {
  const action = request?.action;

  switch (action) {
    case 'today':
      return handleToday(request);
    case 'upcoming':
      return handleUpcoming(request);
    case 'list_events':
      return handleListEvents(request);
    case 'create_event':
      return handleCreateEvent(request);
    case 'update_event':
      return handleUpdateEvent(request);
    case 'delete_event':
      return handleDeleteEvent(request);
    case 'search_events':
      return handleSearchEvents(request);
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

async function processRequestFile() {
  if (isProcessing) {
    hasPendingRun = true;
    return;
  }

  isProcessing = true;

  try {
    if (!fs.existsSync(REQUEST_FILE)) {
      return;
    }

    const stats = fs.statSync(REQUEST_FILE);
    if (stats.mtimeMs <= lastProcessedMtimeMs) {
      return;
    }

    lastProcessedMtimeMs = stats.mtimeMs;

    const raw = fs.readFileSync(REQUEST_FILE, 'utf8');
    const request = JSON.parse(raw);
    const action = request?.action || null;

    log(`processing ${action || 'unknown'} request`);

    try {
      const data = await dispatchRequest(request);
      writeResponse(successResponse(action, data));
      log(`completed ${action}`);
    } catch (err) {
      writeResponse(errorResponse(action, err));
      logError(`action ${action || 'unknown'} failed: ${err.message}`);
    }
  } catch (err) {
    writeResponse(errorResponse(null, err));
    logError(`watcher error: ${err.message}`);
  } finally {
    isProcessing = false;
    if (hasPendingRun) {
      hasPendingRun = false;
      setImmediate(() => {
        processRequestFile().catch((err) => logError(`deferred processing failed: ${err.message}`));
      });
    }
  }
}

fs.watchFile(REQUEST_FILE, { interval: POLL_INTERVAL_MS }, (current, previous) => {
  if (current.mtimeMs === 0 || current.mtimeMs === previous.mtimeMs) {
    return;
  }
  processRequestFile().catch((err) => logError(`processing failed: ${err.message}`));
});

processRequestFile().catch((err) => logError(`startup processing failed: ${err.message}`));

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'calendar' }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  log(`calendar service running on port ${PORT}`);
  log(`watching ${REQUEST_FILE}`);
  log(`health: http://localhost:${PORT}/health`);
});
