import { vi, type Mock } from "vitest";

export const {
  processMessageMock,
  resolveGroupActivationForMock,
  updateLastRouteInBackgroundMock,
  transcribeFirstAudioMock,
  maybeSendAckReactionMock,
  createStatusReactionControllerMock,
}: {
  processMessageMock: Mock;
  resolveGroupActivationForMock: Mock;
  updateLastRouteInBackgroundMock: Mock;
  transcribeFirstAudioMock: Mock;
  maybeSendAckReactionMock: Mock;
  createStatusReactionControllerMock: Mock;
} = vi.hoisted(() => ({
  processMessageMock: vi.fn(),
  resolveGroupActivationForMock: vi.fn(),
  updateLastRouteInBackgroundMock: vi.fn(),
  transcribeFirstAudioMock: vi.fn(),
  maybeSendAckReactionMock: vi.fn(),
  createStatusReactionControllerMock: vi.fn(),
}));

vi.mock("./audio-preflight.runtime.js", () => ({ transcribeFirstAudio: transcribeFirstAudioMock }));
vi.mock("./ack-reaction.js", () => ({ maybeSendAckReaction: maybeSendAckReactionMock }));
vi.mock("./process-message.js", () => ({ processMessage: processMessageMock }));
vi.mock("./status-reaction.js", () => ({
  createWhatsAppStatusReactionController: createStatusReactionControllerMock,
}));
vi.mock("./group-activation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./group-activation.js")>()),
  resolveGroupActivationFor: resolveGroupActivationForMock,
}));
vi.mock("./last-route.js", () => ({
  updateLastRouteInBackground: updateLastRouteInBackgroundMock,
}));
vi.mock("../../group-session-key.js", () => ({
  resolveWhatsAppGroupSessionRoute: (route: unknown) => route,
}));
