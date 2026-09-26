/** Agent Client Protocol bridge that translates ACP sessions/prompts to Gateway chat sessions. */
import type {
  Agent,
  AgentSideConnection,
  InitializeRequest,
  InitializeResponse,
} from "@agentclientprotocol/sdk";
import { createInMemorySessionStore, type AcpSessionStore } from "@openclaw/acp-core/session";
import type { AcpServerOptions } from "@openclaw/acp-core/types";
import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import type { GatewayClient } from "../gateway/client.js";
import { createFixedWindowBudget } from "../infra/fixed-window-rate-limit.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { AcpEventLedger } from "./event-ledger.js";
import type { AcpPendingApprovalRelay } from "./translator.prompt-state.js";
import { AcpTranslatorPromptStream } from "./translator.prompt-stream.js";
import { AcpTranslatorSessionLifecycle } from "./translator.session-lifecycle.js";
import { AcpTranslatorSessionState } from "./translator.session-state.js";
import { AcpTranslatorSessionUpdates } from "./translator.session-updates.js";
import { ACP_AGENT_INFO } from "./types.js";

const SESSION_CREATE_RATE_LIMIT_DEFAULT_MAX_REQUESTS = 120;
const SESSION_CREATE_RATE_LIMIT_DEFAULT_WINDOW_MS = 10_000;

const loadAcpSdkModule = createLazyRuntimeModule(() => import("@agentclientprotocol/sdk"));

type AcpGatewayAgentOptions = AcpServerOptions & {
  eventLedger: AcpEventLedger;
  sessionStore?: AcpSessionStore;
};

/** ACP Agent implementation backed by the OpenClaw Gateway and replay ledger. */
export class AcpGatewayAgent implements Agent {
  private readonly sessionUpdates: AcpTranslatorSessionUpdates;
  private readonly promptStream: AcpTranslatorPromptStream;
  readonly newSession: AcpTranslatorSessionLifecycle["newSession"];
  readonly loadSession: AcpTranslatorSessionLifecycle["loadSession"];
  readonly listSessions: AcpTranslatorSessionLifecycle["listSessions"];
  readonly resumeSession: AcpTranslatorSessionLifecycle["resumeSession"];
  readonly closeSession: AcpTranslatorSessionLifecycle["closeSession"];
  readonly authenticate: AcpTranslatorSessionLifecycle["authenticate"];
  readonly setSessionMode: AcpTranslatorSessionLifecycle["setSessionMode"];
  readonly setSessionConfigOption: AcpTranslatorSessionLifecycle["setSessionConfigOption"];
  readonly prompt: AcpTranslatorPromptStream["prompt"];
  readonly cancel: AcpTranslatorPromptStream["cancel"];
  private readonly ownedSessionStore: ReturnType<typeof createInMemorySessionStore> | undefined;
  private readonly approvalRelays = new Map<string, AcpPendingApprovalRelay>();
  private readonly log: (msg: string) => void;

  constructor(
    connection: AgentSideConnection,
    gateway: GatewayClient,
    opts: AcpGatewayAgentOptions,
  ) {
    this.log = opts.verbose ? (msg: string) => process.stderr.write(`[acp] ${msg}\n`) : () => {};
    // Injected stores remain caller-owned; only the agent-created registry follows shutdown.
    let sessionStore: AcpSessionStore;
    if (opts.sessionStore === undefined) {
      this.ownedSessionStore = createInMemorySessionStore();
      sessionStore = this.ownedSessionStore;
    } else {
      this.ownedSessionStore = undefined;
      sessionStore = opts.sessionStore;
    }
    this.sessionUpdates = new AcpTranslatorSessionUpdates({
      connection,
      eventLedger: opts.eventLedger,
      log: this.log,
    });
    const sessionState = new AcpTranslatorSessionState(gateway, this.sessionUpdates, this.log);
    this.promptStream = new AcpTranslatorPromptStream(
      connection,
      gateway,
      opts,
      sessionStore,
      this.sessionUpdates,
      sessionState,
      this.approvalRelays,
      this.log,
    );
    const sessionCreateRateLimiter = createFixedWindowBudget({
      maxRequests: resolveIntegerOption(
        opts.sessionCreateRateLimit?.maxRequests,
        SESSION_CREATE_RATE_LIMIT_DEFAULT_MAX_REQUESTS,
        { min: 1 },
      ),
      windowMs: resolveIntegerOption(
        opts.sessionCreateRateLimit?.windowMs,
        SESSION_CREATE_RATE_LIMIT_DEFAULT_WINDOW_MS,
        { min: 1_000 },
      ),
    });
    const sessionLifecycle = new AcpTranslatorSessionLifecycle(
      gateway,
      opts,
      sessionStore,
      this.sessionUpdates,
      sessionState,
      sessionCreateRateLimiter,
      (session) => this.promptStream.cancelSessionWork(session),
      this.log,
    );
    this.newSession = sessionLifecycle.newSession.bind(sessionLifecycle);
    this.loadSession = sessionLifecycle.loadSession.bind(sessionLifecycle);
    this.listSessions = sessionLifecycle.listSessions.bind(sessionLifecycle);
    this.resumeSession = sessionLifecycle.resumeSession.bind(sessionLifecycle);
    this.closeSession = sessionLifecycle.closeSession.bind(sessionLifecycle);
    this.authenticate = sessionLifecycle.authenticate.bind(sessionLifecycle);
    this.setSessionMode = sessionLifecycle.setSessionMode.bind(sessionLifecycle);
    this.setSessionConfigOption = sessionLifecycle.setSessionConfigOption.bind(sessionLifecycle);
    this.prompt = this.promptStream.prompt.bind(this.promptStream);
    this.cancel = this.promptStream.cancel.bind(this.promptStream);
  }

  start(): void {
    this.log("ready");
  }

  async shutdown(): Promise<void> {
    this.sessionUpdates.stop();
    try {
      await this.promptStream.shutdown();
    } finally {
      this.ownedSessionStore?.dispose();
    }
  }

  handleGatewayReconnect(): void {
    this.promptStream.handleGatewayReconnect();
  }

  handleGatewayDisconnect(reason: string): void {
    this.promptStream.handleGatewayDisconnect(reason);
  }

  async handleGatewayEvent(evt: EventFrame): Promise<void> {
    await this.promptStream.handleGatewayEvent(evt);
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: (await loadAcpSdkModule()).PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: false,
          sse: false,
        },
        sessionCapabilities: {
          list: {},
          resume: {},
          close: {},
        },
      },
      agentInfo: ACP_AGENT_INFO,
      authMethods: [],
    };
  }
}
