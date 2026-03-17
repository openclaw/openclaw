import { vi } from "vitest";
const sendMocks = vi.hoisted(() => ({
  sendMessageZalouserMock: vi.fn(async () => {
  }),
  sendTypingZalouserMock: vi.fn(async () => {
  }),
  sendDeliveredZalouserMock: vi.fn(async () => {
  }),
  sendSeenZalouserMock: vi.fn(async () => {
  })
}));
const sendMessageZalouserMock = sendMocks.sendMessageZalouserMock;
const sendTypingZalouserMock = sendMocks.sendTypingZalouserMock;
const sendDeliveredZalouserMock = sendMocks.sendDeliveredZalouserMock;
const sendSeenZalouserMock = sendMocks.sendSeenZalouserMock;
vi.mock("./send.js", () => ({
  sendMessageZalouser: sendMessageZalouserMock,
  sendTypingZalouser: sendTypingZalouserMock,
  sendDeliveredZalouser: sendDeliveredZalouserMock,
  sendSeenZalouser: sendSeenZalouserMock
}));
export {
  sendDeliveredZalouserMock,
  sendMessageZalouserMock,
  sendSeenZalouserMock,
  sendTypingZalouserMock
};
