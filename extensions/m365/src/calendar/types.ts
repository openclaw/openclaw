export type CalendarDateTime = {
  dateTime: string;
  timeZone: string;
};

export type CalendarAttendeeType = "required" | "optional" | "resource";

export type CalendarAttendee = {
  email: string;
  name?: string;
  type?: CalendarAttendeeType;
};

export type CalendarChangeOperation = "create" | "update" | "cancel";

export type CalendarEventDraft = {
  subject?: string;
  body?: string;
  bodyContentType?: "text" | "html";
  start?: CalendarDateTime;
  end?: CalendarDateTime;
  location?: string;
  onlineMeeting?: boolean;
  attendees?: CalendarAttendee[];
};

export type CalendarChangeRequest = CalendarEventDraft & {
  operation: CalendarChangeOperation;
  calendarUser: string;
  eventId?: string;
  changeKey?: string;
  comment?: string;
  notifyAttendees?: boolean;
  idempotencyKey?: string;
};

export type CalendarChangePlan = {
  version: 1;
  operation: CalendarChangeOperation;
  calendarUser: string;
  eventId?: string;
  changeKey?: string;
  subject?: string;
  body?: string;
  bodyContentType?: "text" | "html";
  start?: CalendarDateTime;
  end?: CalendarDateTime;
  location?: string;
  onlineMeeting?: boolean;
  attendees: CalendarAttendee[];
  comment?: string;
  notifyAttendees: boolean;
  idempotencyKey?: string;
};

export type CalendarApprovalSnapshot = {
  kind: "m365.calendar.approval";
  version: 1;
  planHash: string;
  title: string;
  description: string;
  severity: "info" | "warning";
  summary: {
    operation: CalendarChangeOperation;
    calendarUser: string;
    eventId?: string;
    changeKey?: string;
    subject?: string;
    timeRange?: string;
    onlineMeeting?: boolean;
    attendeeCount: number;
    attendeeEmails: string[];
    notifyAttendees: boolean;
  };
  plan: CalendarChangePlan;
};

export type QueuedCalendarChange = {
  kind: "m365.calendar.queued_change";
  version: 1;
  planHash: string;
  plan: CalendarChangePlan;
  approvalSnapshot: CalendarApprovalSnapshot;
};

export type CalendarEvent = {
  id: string;
  changeKey?: string;
  subject?: string;
  start?: CalendarDateTime;
  end?: CalendarDateTime;
  location?: string;
  organizerEmail?: string;
  attendeeEmails: string[];
  webLink?: string;
  isCancelled?: boolean;
};

export type CalendarAgendaResult = {
  calendarUser: string;
  start: string;
  end: string;
  events: CalendarEvent[];
};

export type CalendarAvailabilitySlot = {
  start: CalendarDateTime;
  end: CalendarDateTime;
  status: string;
};

export type CalendarAvailabilitySchedule = {
  scheduleId: string;
  availabilityView?: string;
  items: CalendarAvailabilitySlot[];
};

export type CalendarFreeBusyResult = {
  calendarUser: string;
  schedules: CalendarAvailabilitySchedule[];
};

export type CalendarWriteResult = {
  operation: CalendarChangeOperation;
  calendarUser: string;
  planHash: string;
  event?: CalendarEvent;
  cancelled?: boolean;
};
