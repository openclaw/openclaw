import { sendMessageZalo as sendMessageZaloImpl } from "./send.js";

type SendMessageZalo = typeof import("./send.js").sendMessageZalo;

export function sendMessageZalo(...args: Parameters<SendMessageZalo>): ReturnType<SendMessageZalo> {
  return sendMessageZaloImpl(...args);
}
