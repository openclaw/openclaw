export type QQBotGatewaySessionRecovery = {
  clearSession: boolean;
  description: string;
  reconnectMode: "identify" | "resume";
  shouldRefreshToken: boolean;
};

export function resolveQQBotGatewaySessionRecovery(
  code: number,
): QQBotGatewaySessionRecovery | null {
  switch (code) {
    case 4006:
      return {
        clearSession: true,
        description: "session no longer valid",
        reconnectMode: "identify",
        shouldRefreshToken: true,
      };
    case 4007:
      return {
        clearSession: true,
        description: "invalid seq on resume",
        reconnectMode: "identify",
        shouldRefreshToken: true,
      };
    case 4009:
      return {
        clearSession: false,
        description: "session timed out",
        reconnectMode: "resume",
        shouldRefreshToken: true,
      };
    default:
      return null;
  }
}
