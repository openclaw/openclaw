export {
	deleteMatrixMessage,
	editMatrixMessage,
	readMatrixMessages,
	sendMatrixMessage,
} from "./actions/messages.js";
export {
	listMatrixPins,
	pinMatrixMessage,
	unpinMatrixMessage,
} from "./actions/pins.js";
export { voteMatrixPoll } from "./actions/polls.js";
export { updateMatrixOwnProfile } from "./actions/profile.js";
export {
	listMatrixReactions,
	removeMatrixReactions,
} from "./actions/reactions.js";
export { getMatrixMemberInfo, getMatrixRoomInfo } from "./actions/room.js";
export type {
	MatrixActionClientOpts,
	MatrixMessageSummary,
	MatrixReactionSummary,
} from "./actions/types.js";
export {
	acceptMatrixVerification,
	bootstrapMatrixVerification,
	cancelMatrixVerification,
	confirmMatrixVerificationReciprocateQr,
	confirmMatrixVerificationSas,
	generateMatrixVerificationQr,
	getMatrixEncryptionStatus,
	getMatrixRoomKeyBackupStatus,
	getMatrixVerificationSas,
	getMatrixVerificationStatus,
	listMatrixVerifications,
	mismatchMatrixVerificationSas,
	requestMatrixVerification,
	resetMatrixRoomKeyBackup,
	restoreMatrixRoomKeyBackup,
	scanMatrixVerificationQr,
	startMatrixVerification,
	verifyMatrixRecoveryKey,
} from "./actions/verification.js";
export { reactMatrixMessage } from "./send.js";
