type ShouldBypassAcpDispatchForCommand = (typeof import("./dispatch-acp-command-bypass.js"))["shouldBypassAcpDispatchForCommand"];
type TryDispatchAcpReply = (typeof import("./dispatch-acp.js"))["tryDispatchAcpReply"];
export declare function shouldBypassAcpDispatchForCommand(...args: Parameters<ShouldBypassAcpDispatchForCommand>): Promise<Awaited<ReturnType<ShouldBypassAcpDispatchForCommand>>>;
export declare function tryDispatchAcpReply(...args: Parameters<TryDispatchAcpReply>): Promise<Awaited<ReturnType<TryDispatchAcpReply>>>;
export {};
