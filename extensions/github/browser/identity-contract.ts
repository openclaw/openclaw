import type {
  GitHubIdentityFactsSchema,
  PersonalGitHubStatusSchema,
  ToolsGitHubAuthorizeStartResultSchema,
  ToolsGitHubStatusResultSchema,
} from "@openclaw/gateway-protocol";
import type { Static } from "typebox";

export type GitHubIdentityFacts = Static<typeof GitHubIdentityFactsSchema>;
type GitHubIdentityDraft = { token: string; name: string; email: string };
type DeviceCode = Pick<
  Static<typeof ToolsGitHubAuthorizeStartResultSchema>,
  "userCode" | "verificationUri"
>;
type GitHubAuthorizationView =
  | { phase: "idle" }
  | { phase: "starting" | "cancelling" }
  | (DeviceCode & {
      phase: "code" | "pending" | "network_error" | "cancelling" | "finishing" | "cancel_error";
      displayExpiresAtMs: number;
      slowedDown?: boolean;
      message?: string;
    })
  | { phase: "access_denied" | "expired" | "incorrect_device_code" | "failed"; message?: string };

/** The host retains authenticated identity, device-flow timers, and mutation authority. */
export type GitHubIdentityView = {
  readonly status: Static<typeof ToolsGitHubStatusResultSchema> | null;
  readonly personal: Static<typeof PersonalGitHubStatusSchema> | null;
  readonly system: GitHubIdentityFacts | null;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly statusReadable: boolean;
  readonly configurable: boolean;
  readonly authorizable: boolean;
  readonly tokenRevealed: boolean;
  readonly patVisible: boolean;
  readonly connectionReady: boolean;
  readonly authorizationActive: boolean;
  readonly authorization: GitHubAuthorizationView;
  readonly scope: "personal" | "system" | "agent";
  readonly draft: GitHubIdentityDraft;
  setDraft: (field: keyof GitHubIdentityDraft, value: string) => void;
  toggleTokenVisibility: () => void;
  showPatFallback: () => void;
  hidePatFallback: () => void;
  startAuthorization: () => Promise<void>;
  cancelAuthorization: () => Promise<void>;
  verify: () => Promise<void>;
  configure: () => Promise<void>;
  inherit: () => Promise<void>;
  disconnect: () => Promise<void>;
};
