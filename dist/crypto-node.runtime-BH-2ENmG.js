import { createRequire } from "node:module";
//#region extensions/matrix/src/matrix/sdk/crypto-node.runtime.ts
const require = createRequire(import.meta.url);
function loadMatrixCryptoNodeBindings() {
	const { Attachment, EncryptedAttachment } = require("@matrix-org/matrix-sdk-crypto-nodejs");
	return {
		Attachment,
		EncryptedAttachment
	};
}
//#endregion
export { loadMatrixCryptoNodeBindings };
