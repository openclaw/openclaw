export type {
  MatrixActionClientOpts,
  MatrixMessageSummary,
  MatrixReactionSummary,
} from "./actions/types.js";
export {
  sendMatrixMessage,
  editMatrixMessage,
  deleteMatrixMessage,
  readMatrixMessages,
} from "./actions/messages.js";
export { listMatrixReactions, removeMatrixReactions } from "./actions/reactions.js";
export { pinMatrixMessage, unpinMatrixMessage, listMatrixPins } from "./actions/pins.js";
export { getMatrixMemberInfo, getMatrixRoomInfo } from "./actions/room.js";
export { reactMatrixMessage } from "./send.js";
