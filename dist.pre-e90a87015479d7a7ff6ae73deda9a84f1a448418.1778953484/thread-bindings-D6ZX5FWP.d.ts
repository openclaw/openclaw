import { i as OpenClawConfig } from "./types.openclaw-DNoZmPZ8.js";
import { n as PinnedDispatcherPolicy, o as SsrFPolicy } from "./ssrf-B_L-my6p.js";
import { c as ChannelSetupWizardAdapter } from "./setup-wizard-types-BzwIv9aR.js";
import { H as ChannelSetupAdapter } from "./types.adapters-DDO_sgP8.js";
import { t as MatrixClient } from "./sdk-C0CVG_SG.js";
import { t as MatrixThreadBindingManager } from "./thread-bindings-shared-CAFCxS67.js";

//#region extensions/matrix/src/setup-core.d.ts
type MatrixSetupWizardModule = {
  matrixSetupWizard: ChannelSetupWizardAdapter;
};
declare function createMatrixSetupWizardProxy(loadWizardModule: () => Promise<MatrixSetupWizardModule>): ChannelSetupWizardAdapter;
declare const matrixSetupAdapter: ChannelSetupAdapter;
//#endregion
//#region extensions/matrix/src/onboarding.d.ts
declare const matrixOnboardingAdapter: ChannelSetupWizardAdapter;
//#endregion
//#region extensions/matrix/src/matrix/client/types.d.ts
/**
 * Authenticated Matrix configuration.
 * Note: deviceId is NOT included here because it's implicit in the accessToken.
 * Matrix storage reuses the most complete account-scoped root it can find for the
 * same homeserver/user/account tuple so token refreshes do not strand prior state.
 * If the device identity itself changes or crypto storage is lost, crypto state may
 * still need to be recreated together with the new access token.
 */
type MatrixAuth = {
  accountId: string;
  homeserver: string;
  userId: string;
  accessToken: string;
  password?: string;
  deviceId?: string;
  deviceName?: string;
  initialSyncLimit?: number;
  encryption?: boolean;
  allowPrivateNetwork?: boolean;
  ssrfPolicy?: SsrFPolicy;
  dispatcherPolicy?: PinnedDispatcherPolicy;
};
//#endregion
//#region extensions/matrix/src/matrix/thread-bindings.d.ts
declare function createMatrixThreadBindingManager(params: {
  cfg: OpenClawConfig;
  accountId: string;
  auth: MatrixAuth;
  client: MatrixClient;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  idleTimeoutMs: number;
  maxAgeMs: number;
  enableSweeper?: boolean;
  logVerboseMessage?: (message: string) => void;
}): Promise<MatrixThreadBindingManager>;
//#endregion
export { matrixSetupAdapter as i, matrixOnboardingAdapter as n, createMatrixSetupWizardProxy as r, createMatrixThreadBindingManager as t };