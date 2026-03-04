# `OpenClawApp` — Web Component Trung Tâm

**File**: `src/ui/app.ts`  
**Custom Element**: `<openclaw-app>`  
**Base class**: `LitElement`

---

## Tổng Quan

`OpenClawApp` là **single Web Component** đóng gói toàn bộ ứng dụng. Không có routing framework — mọi tab đều được render conditional trong component này.

Pattern thiết kế: **State máy lớn (God Component)** — tất cả state tập trung, nhưng logic được phân tách sang các module `app-*.ts` và `controllers/*.ts`.

```ts
@customElement("openclaw-app")
export class OpenClawApp extends LitElement {
  // ~100 @state properties
  render() {
    return renderApp(this as AppViewState);
  }
}
```

---

## Lifecycle

```
connectedCallback()    → handleConnected(host)
  ├── Infer basePath từ URL
  ├── Load control-ui bootstrap config
  ├── Apply settings từ URL params
  ├── Sync tab với browser location
  ├── Sync theme
  ├── Attach theme media listener
  ├── connectGateway()
  └── Start nodes polling

firstUpdated()         → handleFirstUpdated(host)
  └── observeTopbar() (ResizeObserver)

disconnectedCallback() → handleDisconnected(host)
  ├── Remove event listeners
  ├── Stop all polling
  ├── Stop gateway client
  └── Detach theme listener

updated(changed)       → handleUpdated(host, changed)
  ├── Khi tab=chat & messages changed → scheduleChatScroll()
  └── Khi tab=logs & entries changed → scheduleLogsScroll()
```

---

## State Properties (nhóm theo tính năng)

### Gateway & Auth

```ts
connected: boolean;
hello: GatewayHelloOk | null;
lastError: string | null;
lastErrorCode: string | null;
password: string;
settings: UiSettings;
```

### Navigation

```ts
tab: Tab; // "chat" | "overview" | "channels" | ...
onboarding: boolean; // URL param ?onboarding=1
basePath: string; // Auto-inferred từ pathname
```

### Theme

```ts
theme: ThemeMode; // "dark" | "light" | "system"
themeResolved: "dark" | "light"; // Actual resolved theme
```

### Chat State (rất nhiều)

```ts
sessionKey: string
chatLoading: boolean
chatSending: boolean
chatMessage: string
chatMessages: unknown[]
chatToolMessages: unknown[]
chatStream: string | null       // Streaming response text
chatStreamStartedAt: number | null
chatRunId: string | null
compactionStatus: CompactionStatus | null
fallbackStatus: FallbackStatus | null
chatAvatarUrl: string | null
chatThinkingLevel: string | null
chatQueue: ChatQueueItem[]
chatAttachments: ChatAttachment[]
chatManualRefreshInFlight: boolean
chatNewMessagesBelow: boolean
sidebarOpen: boolean            // Tool output sidebar
sidebarContent: string | null
splitRatio: number              // 0.4–0.7, resize split
```

### Agents

```ts
(agentsLoading, agentsList, agentsError, agentsSelectedId);
agentsPanel: "overview" | "files" | "tools" | "skills" | "channels" | "cron";
(agentFilesLoading, agentFilesList, agentFileContents, agentFileDrafts);
(agentFileActive, agentFileSaving);
(agentIdentityLoading, agentIdentityById);
(agentSkillsLoading, agentSkillsReport);
(toolsCatalogLoading, toolsCatalogResult);
```

### Sessions

```ts
(sessionsLoading, sessionsResult, sessionsError);
sessionsFilterActive: string; // minutes string
sessionsFilterLimit: string; // limit string
sessionsIncludeGlobal: boolean;
sessionsIncludeUnknown: boolean;
```

### Config

```ts
(configLoading, configRaw, configRawOriginal);
(configValid, configIssues, configSaving, configApplying);
(configSnapshot, configSchema, configUiHints);
configForm: Record<string, unknown> | null;
(configFormOriginal, configFormDirty);
configFormMode: "form" | "raw";
(configSearchQuery, configActiveSection, configActiveSubsection);
(applySessionKey, updateRunning);
```

### Channels

```ts
(channelsLoading, channelsSnapshot, channelsError, channelsLastSuccess);
(whatsappLoginMessage, whatsappLoginQrDataUrl, whatsappLoginConnected, whatsappBusy);
(nostrProfileFormState, nostrProfileAccountId);
```

### Cron (phức tạp nhất)

```ts
(cronLoading, cronJobsLoadingMore);
(cronJobs, cronJobsTotal, cronJobsHasMore, cronJobsNextOffset, cronJobsLimit);
(cronJobsQuery, cronJobsEnabledFilter, cronJobsSortBy, cronJobsSortDir);
(cronStatus, cronError, cronForm, cronFieldErrors);
(cronEditingJobId, cronRunsJobId);
(cronRuns, cronRunsTotal, cronRunsHasMore, cronRunsNextOffset, cronRunsLimit);
(cronRunsScope, cronRunsStatuses, cronRunsDeliveryStatuses);
(cronRunsStatusFilter, cronRunsQuery, cronRunsSortDir);
(cronModelSuggestions, cronBusy);
```

### Usage Analytics

```ts
(usageLoading, usageResult, usageCostSummary, usageError);
(usageStartDate, usageEndDate);
(usageSelectedSessions, usageSelectedDays, usageSelectedHours);
usageChartMode: "tokens" | "cost";
usageDailyChartMode: "total" | "by-type";
usageTimeSeriesMode: "cumulative" | "per-turn";
(usageTimeSeries, usageTimeSeriesLoading, usageTimeSeriesCursorStart / End);
(usageSessionLogs, usageSessionLogsLoading, usageSessionLogsExpanded);
(usageQuery, usageQueryDraft, usageQueryDebounceTimer);
(usageSessionSort, usageSessionSortDir, usageRecentSessions);
usageTimeZone: "local" | "utc";
(usageContextExpanded, usageHeaderPinned, usageSessionsTab);
(usageVisibleColumns, usageLogFilterRoles, usageLogFilterTools);
(usageLogFilterHasTools, usageLogFilterQuery);
```

### Skills, Debug, Logs, Nodes, Presence, Devices, ExecApprovals

(mỗi nhóm có khoảng 3–8 state properties tương ứng)

---

## Methods Public

### Gateway

```ts
connect(); // connectGateway(this)
```

### Navigation

```ts
setTab(next: Tab)
setTheme(next: ThemeMode, context?)
applySettings(next: UiSettings)
```

### Chat

```ts
handleSendChat(messageOverride?, opts?)
handleAbortChat()
removeQueuedMessage(id: string)
resetToolStream()
resetChatScroll()
scrollToBottom(opts?)
setChatMessage(next: string)               // Alias for state update
setSessionKey(next: string)
```

### Sidebar

```ts
handleOpenSidebar(content: string)
handleCloseSidebar()
handleSplitRatioChange(ratio: number)
```

### Data Loading

```ts
loadOverview();
loadAssistantIdentity();
loadCron();
```

### Channel Handlers

```ts
handleWhatsAppStart(force: boolean)
handleWhatsAppWait()
handleWhatsAppLogout()
handleChannelConfigSave()
handleChannelConfigReload()
handleNostrProfileEdit(accountId, profile)
handleNostrProfileCancel()
handleNostrProfileFieldChange(field, value)
handleNostrProfileSave()
handleNostrProfileImport()
handleNostrProfileToggleAdvanced()
```

### Exec Approvals

```ts
handleExecApprovalDecision(decision: "allow-once"|"allow-always"|"deny")
```

### Gateway URL Confirm/Cancel

```ts
handleGatewayUrlConfirm();
handleGatewayUrlCancel();
```

---

## `createRenderRoot()`

```ts
createRenderRoot() {
  return this;  // Không dùng Shadow DOM!
}
```

> Toàn bộ app render vào Light DOM để CSS toàn cục hoạt động được.

---

## `AppViewState` Interface

`AppViewState` (`app-view-state.ts`) là **interface typing đầy đủ** của `OpenClawApp` — được dùng để truyền vào các `render*()` functions và `controllers`.

Pattern này cho phép **tách biệt concern**: `app.ts` chứa state + lifecycle, còn render logic và controller logic ở file riêng, chỉ nhận `AppViewState` như parameter.

```ts
// app-render.ts
export function renderApp(state: AppViewState) { ... }

// controllers/sessions.ts
export async function loadSessions(host: Pick<AppViewState, "client"|"sessionsLoading"|...>) { ... }
```
