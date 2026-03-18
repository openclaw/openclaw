import { i as __require, t as __commonJSMin } from "./chunk-DORXReHP.js";
//#region node_modules/.pnpm/@matrix-org+matrix-sdk-crypto-nodejs@0.4.0/node_modules/@matrix-org/matrix-sdk-crypto-nodejs/index.js
var require_matrix_sdk_crypto_nodejs = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const { existsSync, readFileSync } = __require("fs");
	const { join } = __require("path");
	const { platform, arch } = process;
	let nativeBinding = null;
	let localFileExisted = false;
	let loadError = null;
	function isMusl() {
		if (!process.report || typeof process.report.getReport !== "function") try {
			return readFileSync(__require("child_process").execSync("which ldd").toString().trim(), "utf8").includes("musl");
		} catch (e) {
			return true;
		}
		else {
			const { glibcVersionRuntime } = process.report.getReport().header;
			return !glibcVersionRuntime;
		}
	}
	switch (platform) {
		case "android":
			switch (arch) {
				case "arm64":
					localFileExisted = existsSync(join(__dirname, "matrix-sdk-crypto.android-arm64.node"));
					try {
						if (localFileExisted) nativeBinding = __require("./matrix-sdk-crypto.android-arm64.node");
						else nativeBinding = __require("@matrix-org/matrix-sdk-crypto-nodejs-android-arm64");
					} catch (e) {
						loadError = e;
					}
					break;
				case "arm":
					localFileExisted = existsSync(join(__dirname, "matrix-sdk-crypto.android-arm-eabi.node"));
					try {
						if (localFileExisted) nativeBinding = __require("./matrix-sdk-crypto.android-arm-eabi.node");
						else nativeBinding = __require("@matrix-org/matrix-sdk-crypto-nodejs-android-arm-eabi");
					} catch (e) {
						loadError = e;
					}
					break;
				default: throw new Error(`Unsupported architecture on Android ${arch}`);
			}
			break;
		case "win32":
			switch (arch) {
				case "x64":
					localFileExisted = existsSync(join(__dirname, "matrix-sdk-crypto.win32-x64-msvc.node"));
					try {
						if (localFileExisted) nativeBinding = __require("./matrix-sdk-crypto.win32-x64-msvc.node");
						else nativeBinding = __require("@matrix-org/matrix-sdk-crypto-nodejs-win32-x64-msvc");
					} catch (e) {
						loadError = e;
					}
					break;
				case "ia32":
					localFileExisted = existsSync(join(__dirname, "matrix-sdk-crypto.win32-ia32-msvc.node"));
					try {
						if (localFileExisted) nativeBinding = __require("./matrix-sdk-crypto.win32-ia32-msvc.node");
						else nativeBinding = __require("@matrix-org/matrix-sdk-crypto-nodejs-win32-ia32-msvc");
					} catch (e) {
						loadError = e;
					}
					break;
				case "arm64":
					localFileExisted = existsSync(join(__dirname, "matrix-sdk-crypto.win32-arm64-msvc.node"));
					try {
						if (localFileExisted) nativeBinding = __require("./matrix-sdk-crypto.win32-arm64-msvc.node");
						else nativeBinding = __require("@matrix-org/matrix-sdk-crypto-nodejs-win32-arm64-msvc");
					} catch (e) {
						loadError = e;
					}
					break;
				default: throw new Error(`Unsupported architecture on Windows: ${arch}`);
			}
			break;
		case "darwin":
			localFileExisted = existsSync(join(__dirname, "matrix-sdk-crypto.darwin-universal.node"));
			try {
				if (localFileExisted) nativeBinding = __require("./matrix-sdk-crypto.darwin-universal.node");
				else nativeBinding = __require("@matrix-org/matrix-sdk-crypto-nodejs-darwin-universal");
				break;
			} catch {}
			switch (arch) {
				case "x64":
					localFileExisted = existsSync(join(__dirname, "matrix-sdk-crypto.darwin-x64.node"));
					try {
						if (localFileExisted) nativeBinding = __require("./matrix-sdk-crypto.darwin-x64.node");
						else nativeBinding = __require("@matrix-org/matrix-sdk-crypto-nodejs-darwin-x64");
					} catch (e) {
						loadError = e;
					}
					break;
				case "arm64":
					localFileExisted = existsSync(join(__dirname, "matrix-sdk-crypto.darwin-arm64.node"));
					try {
						if (localFileExisted) nativeBinding = __require("./matrix-sdk-crypto.darwin-arm64.node");
						else nativeBinding = __require("@matrix-org/matrix-sdk-crypto-nodejs-darwin-arm64");
					} catch (e) {
						loadError = e;
					}
					break;
				default: throw new Error(`Unsupported architecture on macOS: ${arch}`);
			}
			break;
		case "freebsd":
			if (arch !== "x64") throw new Error(`Unsupported architecture on FreeBSD: ${arch}`);
			localFileExisted = existsSync(join(__dirname, "matrix-sdk-crypto.freebsd-x64.node"));
			try {
				if (localFileExisted) nativeBinding = __require("./matrix-sdk-crypto.freebsd-x64.node");
				else nativeBinding = __require("@matrix-org/matrix-sdk-crypto-nodejs-freebsd-x64");
			} catch (e) {
				loadError = e;
			}
			break;
		case "linux":
			switch (arch) {
				case "x64":
					if (isMusl()) {
						localFileExisted = existsSync(join(__dirname, "matrix-sdk-crypto.linux-x64-musl.node"));
						try {
							if (localFileExisted) nativeBinding = __require("./matrix-sdk-crypto.linux-x64-musl.node");
							else nativeBinding = __require("@matrix-org/matrix-sdk-crypto-nodejs-linux-x64-musl");
						} catch (e) {
							loadError = e;
						}
					} else {
						localFileExisted = existsSync(join(__dirname, "matrix-sdk-crypto.linux-x64-gnu.node"));
						try {
							if (localFileExisted) nativeBinding = __require("./matrix-sdk-crypto.linux-x64-gnu.node");
							else nativeBinding = __require("@matrix-org/matrix-sdk-crypto-nodejs-linux-x64-gnu");
						} catch (e) {
							loadError = e;
						}
					}
					break;
				case "arm64":
					if (isMusl()) {
						localFileExisted = existsSync(join(__dirname, "matrix-sdk-crypto.linux-arm64-musl.node"));
						try {
							if (localFileExisted) nativeBinding = __require("./matrix-sdk-crypto.linux-arm64-musl.node");
							else nativeBinding = __require("@matrix-org/matrix-sdk-crypto-nodejs-linux-arm64-musl");
						} catch (e) {
							loadError = e;
						}
					} else {
						localFileExisted = existsSync(join(__dirname, "matrix-sdk-crypto.linux-arm64-gnu.node"));
						try {
							if (localFileExisted) nativeBinding = __require("./matrix-sdk-crypto.linux-arm64-gnu.node");
							else nativeBinding = __require("@matrix-org/matrix-sdk-crypto-nodejs-linux-arm64-gnu");
						} catch (e) {
							loadError = e;
						}
					}
					break;
				case "arm":
					if (isMusl()) {
						localFileExisted = existsSync(join(__dirname, "matrix-sdk-crypto.linux-arm-musleabihf.node"));
						try {
							if (localFileExisted) nativeBinding = __require("./matrix-sdk-crypto.linux-arm-musleabihf.node");
							else nativeBinding = __require("@matrix-org/matrix-sdk-crypto-nodejs-linux-arm-musleabihf");
						} catch (e) {
							loadError = e;
						}
					} else {
						localFileExisted = existsSync(join(__dirname, "matrix-sdk-crypto.linux-arm-gnueabihf.node"));
						try {
							if (localFileExisted) nativeBinding = __require("./matrix-sdk-crypto.linux-arm-gnueabihf.node");
							else nativeBinding = __require("@matrix-org/matrix-sdk-crypto-nodejs-linux-arm-gnueabihf");
						} catch (e) {
							loadError = e;
						}
					}
					break;
				case "riscv64":
					if (isMusl()) {
						localFileExisted = existsSync(join(__dirname, "matrix-sdk-crypto.linux-riscv64-musl.node"));
						try {
							if (localFileExisted) nativeBinding = __require("./matrix-sdk-crypto.linux-riscv64-musl.node");
							else nativeBinding = __require("@matrix-org/matrix-sdk-crypto-nodejs-linux-riscv64-musl");
						} catch (e) {
							loadError = e;
						}
					} else {
						localFileExisted = existsSync(join(__dirname, "matrix-sdk-crypto.linux-riscv64-gnu.node"));
						try {
							if (localFileExisted) nativeBinding = __require("./matrix-sdk-crypto.linux-riscv64-gnu.node");
							else nativeBinding = __require("@matrix-org/matrix-sdk-crypto-nodejs-linux-riscv64-gnu");
						} catch (e) {
							loadError = e;
						}
					}
					break;
				case "s390x":
					localFileExisted = existsSync(join(__dirname, "matrix-sdk-crypto.linux-s390x-gnu.node"));
					try {
						if (localFileExisted) nativeBinding = __require("./matrix-sdk-crypto.linux-s390x-gnu.node");
						else nativeBinding = __require("@matrix-org/matrix-sdk-crypto-nodejs-linux-s390x-gnu");
					} catch (e) {
						loadError = e;
					}
					break;
				default: throw new Error(`Unsupported architecture on Linux: ${arch}`);
			}
			break;
		default: throw new Error(`Unsupported OS: ${platform}, architecture: ${arch}`);
	}
	if (!nativeBinding) {
		if (loadError) throw loadError;
		throw new Error(`Failed to load native binding`);
	}
	const { Attachment, EncryptedAttachment, BackupDecryptionKey, MegolmV1BackupKey, RoomKeyCounts, BackupKeys, EncryptionAlgorithm, EncryptionSettings, ShieldColor, ShieldStateCode, ShieldState, HistoryVisibility, UserId, DeviceId, DeviceKeyId, DeviceKeyAlgorithm, DeviceKeyAlgorithmName, RoomId, ServerName, StoreType, OlmMachine, CrossSigningStatus, KeysUploadRequest, KeysQueryRequest, KeysClaimRequest, ToDeviceRequest, SignatureUploadRequest, RoomMessageRequest, KeysBackupRequest, RequestType, DecryptedRoomEvent, DeviceLists, Signatures, Signature, MaybeSignature, SignatureVerification, SignatureState, Ed25519PublicKey, Ed25519Signature, Curve25519PublicKey, IdentityKeys, Versions, getVersions } = nativeBinding;
	module.exports.Attachment = Attachment;
	module.exports.EncryptedAttachment = EncryptedAttachment;
	module.exports.BackupDecryptionKey = BackupDecryptionKey;
	module.exports.MegolmV1BackupKey = MegolmV1BackupKey;
	module.exports.RoomKeyCounts = RoomKeyCounts;
	module.exports.BackupKeys = BackupKeys;
	module.exports.EncryptionAlgorithm = EncryptionAlgorithm;
	module.exports.EncryptionSettings = EncryptionSettings;
	module.exports.ShieldColor = ShieldColor;
	module.exports.ShieldStateCode = ShieldStateCode;
	module.exports.ShieldState = ShieldState;
	module.exports.HistoryVisibility = HistoryVisibility;
	module.exports.UserId = UserId;
	module.exports.DeviceId = DeviceId;
	module.exports.DeviceKeyId = DeviceKeyId;
	module.exports.DeviceKeyAlgorithm = DeviceKeyAlgorithm;
	module.exports.DeviceKeyAlgorithmName = DeviceKeyAlgorithmName;
	module.exports.RoomId = RoomId;
	module.exports.ServerName = ServerName;
	module.exports.StoreType = StoreType;
	module.exports.OlmMachine = OlmMachine;
	module.exports.CrossSigningStatus = CrossSigningStatus;
	module.exports.KeysUploadRequest = KeysUploadRequest;
	module.exports.KeysQueryRequest = KeysQueryRequest;
	module.exports.KeysClaimRequest = KeysClaimRequest;
	module.exports.ToDeviceRequest = ToDeviceRequest;
	module.exports.SignatureUploadRequest = SignatureUploadRequest;
	module.exports.RoomMessageRequest = RoomMessageRequest;
	module.exports.KeysBackupRequest = KeysBackupRequest;
	module.exports.RequestType = RequestType;
	module.exports.DecryptedRoomEvent = DecryptedRoomEvent;
	module.exports.DeviceLists = DeviceLists;
	module.exports.Signatures = Signatures;
	module.exports.Signature = Signature;
	module.exports.MaybeSignature = MaybeSignature;
	module.exports.SignatureVerification = SignatureVerification;
	module.exports.SignatureState = SignatureState;
	module.exports.Ed25519PublicKey = Ed25519PublicKey;
	module.exports.Ed25519Signature = Ed25519Signature;
	module.exports.Curve25519PublicKey = Curve25519PublicKey;
	module.exports.IdentityKeys = IdentityKeys;
	module.exports.Versions = Versions;
	module.exports.getVersions = getVersions;
}));
//#endregion
export default require_matrix_sdk_crypto_nodejs();
export {};
