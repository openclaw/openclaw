import {
  registerBrowserExtension,
  type BrowserExtensionRegistration,
  type BrowserExtensionRequest,
  type ExtensionHostSession,
} from "openclaw/plugin-sdk/browser-extension-host";
import { z } from "zod";
import type { AgenticAutofillExtension, ExtResult } from "./autofill-contract.js";

// This declaration describes the vendor global inside serialized worker functions only.
declare const api: {
  initialization: { v1: { whenSettled(): Promise<unknown> } };
  agenticMode?: {
    v1: {
      enable(p: { tabId: number }): Promise<unknown>;
      disable(p: { tabId: number }): Promise<unknown>;
    };
  };
  agenticAutofill?: {
    v1: {
      createAccessRequest(
        p: Parameters<AgenticAutofillExtension["createAccessRequest"]>[0],
      ): Promise<unknown>;
      getAccessRequestStatus(
        p: Parameters<AgenticAutofillExtension["getAccessRequestStatus"]>[0],
      ): Promise<unknown>;
      fillCredential(p: {
        accessToken: string;
        integrationKey: string;
        resourcePath: string;
        tabId: number;
      }): Promise<unknown>;
    };
  };
};

const failure = z.object({ success: z.literal(false), error: z.object({ code: z.string() }) });
const entry = z.object({
  id: z.string(),
  type: z.literal("login"),
  parameters: z.object({ website: z.string() }),
  reason: z.string().optional(),
  keywords: z.array(z.string()).optional(),
});
const created = z.object({
  accessRequest: z.object({
    // The documented response omits version, although requests always use version 2.
    version: z.literal(2).default(2),
    id: z.string(),
    path: z.string(),
    identity: z.string(),
    state: z.string(),
    createdAt: z.string(),
    goal: z.string(),
    entries: z.array(entry),
  }),
  appLink: z.string().startsWith("onepassword://"),
});
const status = z.object({
  path: z.string(),
  state: z.string(),
  resolved: z.array(
    z.object({
      entryId: z
        .string()
        .nullish()
        .transform((value) => value ?? undefined),
      reference: z.string(),
    }),
  ),
});
const filled = z.object({ status: z.literal("fill_submitted") });
const mode = z.union([z.object({ success: z.literal(true) }), failure]);
const ready = z.object({ state: z.literal("ready"), available: z.literal(true) });
const internal = { success: false, error: { code: "internal" } } as const;
export const autofillBrowserGuidance =
  "Stop the dedicated browser profile and restart the Gateway. Set agenticAutofill.extensionPath to an unpacked 1Password Nightly extension (8.12.46.6+ with its manifest key), and browserProfile to the managed Chromium profile your agent uses. Use Chromium or Chrome for Testing, not branded Chrome; install full Playwright Chromium and allow my.1password.com for API availability. Do not change extension files while running.";

/** Validate every vendor envelope; never reflect arbitrary worker data in diagnostics. */
function parseResult<T>(schema: z.ZodType<T>, value: unknown): ExtResult<T> {
  const parsed = z
    .union([z.object({ success: z.literal(true), result: schema }), failure])
    .safeParse(value);
  return parsed.success ? parsed.data : internal;
}

/** Plugin-owned adapter; one owner-only profile attachment survives the approval polling window. */
export class BrowserAutofillExtension implements AgenticAutofillExtension {
  private registration: BrowserExtensionRegistration | undefined;
  private starting: Promise<void> | undefined;
  private session: Promise<ExtensionHostSession> | undefined;
  private closed = false;

  constructor(
    private readonly options: { extensionPath?: string; browserProfile?: string },
    private readonly register: (
      request: BrowserExtensionRequest,
    ) => Promise<BrowserExtensionRegistration> = registerBrowserExtension,
  ) {}

  /** Reserve before launch; failures stay observable through status without leaking host errors. */
  async start(): Promise<void> {
    this.starting ??= (async () => {
      if (this.closed || !this.options.extensionPath || !this.options.browserProfile) {
        return;
      }
      try {
        const registration = await this.register({
          profile: this.options.browserProfile,
          principal: "onepassword:gateway-owner",
          extension: {
            id: "gejiddohjgogedgjnonbofjigllpkmbf",
            unpackedPath: this.options.extensionPath,
            minimumVersion: "8.12.46.6",
          },
        });
        if (this.closed) {
          await registration.close();
        } else {
          this.registration = registration;
        }
      } catch {
        // Missing files, old versions, and running profiles share a safe actionable diagnostic.
      }
    })();
    await this.starting;
  }

  private async attached(): Promise<ExtensionHostSession> {
    await this.start();
    if (this.closed || !this.registration) {
      throw new Error("Extension unavailable");
    }
    this.session ??= this.registration.openSession();
    return await this.session;
  }

  private async initialized(): Promise<ExtensionHostSession | undefined> {
    const session = await this.attached();
    const result = await session.callInServiceWorker(
      async () => ({
        state: await api.initialization.v1.whenSettled(),
        available: Boolean(api.agenticAutofill?.v1 && api.agenticMode?.v1),
      }),
      undefined,
    );
    return ready.safeParse(result).success ? session : undefined;
  }

  /** Probe initialization without tokens, network requests for grants, or raw diagnostics. */
  async readiness(): Promise<ExtResult<{ status: "ready" }>> {
    try {
      return (await this.initialized())
        ? { success: true, result: { status: "ready" } }
        : { success: false, error: { code: "extensionNotReady" } };
    } catch {
      return { success: false, error: { code: "extensionNotReady" } };
    }
  }

  private async call<T>(
    run: (session: ExtensionHostSession) => Promise<ExtResult<T>>,
  ): Promise<ExtResult<T>> {
    try {
      const session = await this.initialized();
      return session
        ? await run(session)
        : { success: false, error: { code: "extensionNotReady" } };
    } catch {
      // Never retry an uncertain worker call, especially a fill or request creation.
      return { success: false, error: { code: "extensionNotReady" } };
    }
  }

  /** Tokens and keys are argument values, never captured in serialized function source. */
  async createAccessRequest(p: Parameters<AgenticAutofillExtension["createAccessRequest"]>[0]) {
    return await this.call(async (session) =>
      parseResult(
        created,
        await session.callInServiceWorker(
          (args: typeof p) => api.agenticAutofill!.v1.createAccessRequest(args),
          p,
        ),
      ),
    );
  }

  /** Reuse the attached worker while the owner waits for approval. */
  async getAccessRequestStatus(
    p: Parameters<AgenticAutofillExtension["getAccessRequestStatus"]>[0],
  ) {
    return await this.call(async (session) =>
      parseResult(
        status,
        await session.callInServiceWorker(
          (args: typeof p) => api.agenticAutofill!.v1.getAccessRequestStatus(args),
          p,
        ),
      ),
    );
  }

  /** Keep tab mapping, Agentic Mode, fill/submit, and mode release inside the browser lock. */
  async fillCredential(p: Parameters<AgenticAutofillExtension["fillCredential"]>[0]) {
    if (p.tab.profile && p.tab.profile !== this.options.browserProfile) {
      return { success: false, error: { code: "invalidTabId" } } as const;
    }
    return await this.call((session) =>
      session.withExclusiveTab(p.tab, async () => {
        const tabId = await session.resolveChromeTabId(p.tab);
        const enabled = mode.safeParse(
          await session.callInServiceWorker(
            (args: { tabId: number }) => api.agenticMode!.v1.enable(args),
            { tabId },
          ),
        );
        if (!enabled.success) {
          return internal;
        }
        if (!enabled.data.success) {
          return enabled.data;
        }
        let result: unknown;
        let released: boolean;
        try {
          const { accessToken, integrationKey, resourcePath } = p;
          result = await session.callInServiceWorker(
            (args: {
              accessToken: string;
              integrationKey: string;
              resourcePath: string;
              tabId: number;
            }) => api.agenticAutofill!.v1.fillCredential(args),
            { accessToken, integrationKey, resourcePath, tabId },
          );
        } finally {
          // Avoid a duplicate enable on multi-page sign-in; release only our own tab scope.
          const disabled = mode.safeParse(
            await session.callInServiceWorker(
              (args: { tabId: number }) => api.agenticMode!.v1.disable(args),
              { tabId },
            ),
          );
          released = disabled.success && disabled.data.success;
        }
        if (!released) {
          throw new Error("Agentic Mode release failed");
        }
        return parseResult(filled, result);
      }),
    );
  }

  /** Retire worker capabilities and stop the owned browser on plugin shutdown. */
  async close(): Promise<void> {
    this.closed = true;
    await this.starting;
    const session = await this.session?.catch(() => undefined);
    try {
      await session?.close();
    } finally {
      await this.registration?.close();
    }
  }
}
