type StartWebLoginWithQr = typeof import("./src/login-qr.js").startWebLoginWithQr;
type WaitForWebLogin = typeof import("./src/login-qr.js").waitForWebLogin;
export declare function startWebLoginWithQr(...args: Parameters<StartWebLoginWithQr>): ReturnType<StartWebLoginWithQr>;
export declare function waitForWebLogin(...args: Parameters<WaitForWebLogin>): ReturnType<WaitForWebLogin>;
export {};
