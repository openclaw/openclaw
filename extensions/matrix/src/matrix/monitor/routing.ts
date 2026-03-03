import type { MatrixRoomConfigResolved } from "./rooms.js";

export function shouldForceMatrixRoomRouting(params: {
  forceRoomRouting: boolean;
  roomConfigResolved: MatrixRoomConfigResolved;
}): boolean {
  if (!params.forceRoomRouting) {
    return false;
  }

  return params.roomConfigResolved.allowlistConfigured && params.roomConfigResolved.allowed;
}
