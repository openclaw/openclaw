import { AcpSessionManager } from "./manager.core.js";
export { AcpSessionManager } from "./manager.core.js";
let ACP_SESSION_MANAGER_SINGLETON = null;
export function getAcpSessionManager() {
    if (!ACP_SESSION_MANAGER_SINGLETON) {
        ACP_SESSION_MANAGER_SINGLETON = new AcpSessionManager();
    }
    return ACP_SESSION_MANAGER_SINGLETON;
}
export const __testing = {
    resetAcpSessionManagerForTests() {
        ACP_SESSION_MANAGER_SINGLETON = null;
    },
};
