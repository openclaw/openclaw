import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildSourceConversationContext, buildGroupIntro } from "../../auto-reply/reply/groups.js";
import { buildInboundMetaSystemPrompt } from "../../auto-reply/reply/inbound-meta.js";
import type { TemplateContext } from "../../auto-reply/templating.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import { deleteSessionEntryLifecycle } from "../../config/sessions/session-accessor.sqlite-lifecycle.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { resolveVisibleActiveSessionRunState } from "../../gateway/server-methods/session-active-runs.js";
import { registerAgentRunCapacityWait } from "../../infra/agent-run-capacity-wait.js";
import {
  clearAgentRunContext,
  getAgentRunLifecycleGeneration,
} from "../../infra/agent-run-registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createDirectOutboundTestAdapter,
  createOutboundTestPlugin,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { splitExtraSystemPrompt } from "../internal-runtime-context.js";
import { prepareEmbeddedSessionState } from "./session-preparation.js";
