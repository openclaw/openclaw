//#region extensions/matrix/src/matrix/backup-health.ts
function resolveMatrixRoomKeyBackupIssue(backup) {
	if (!backup.serverVersion) return {
		code: "missing-server-backup",
		summary: "missing on server",
		message: "no room-key backup exists on the homeserver"
	};
	if (backup.decryptionKeyCached === false) {
		if (backup.keyLoadError) return {
			code: "key-load-failed",
			summary: "present but backup key unavailable on this device",
			message: `backup decryption key could not be loaded from secret storage (${backup.keyLoadError})`
		};
		if (backup.keyLoadAttempted) return {
			code: "key-not-loaded",
			summary: "present but backup key unavailable on this device",
			message: "backup decryption key is not loaded on this device (secret storage did not return a key)"
		};
		return {
			code: "key-not-loaded",
			summary: "present but backup key unavailable on this device",
			message: "backup decryption key is not loaded on this device"
		};
	}
	if (backup.matchesDecryptionKey === false) return {
		code: "key-mismatch",
		summary: "present but backup key mismatch on this device",
		message: "backup key mismatch (this device does not have the matching backup decryption key)"
	};
	if (backup.trusted === false) return {
		code: "untrusted-signature",
		summary: "present but not trusted on this device",
		message: "backup signature chain is not trusted by this device"
	};
	if (!backup.activeVersion) return {
		code: "inactive",
		summary: "present on server but inactive on this device",
		message: "backup exists but is not active on this device"
	};
	if (backup.trusted === null || backup.matchesDecryptionKey === null || backup.decryptionKeyCached === null) return {
		code: "indeterminate",
		summary: "present but trust state unknown",
		message: "backup trust state could not be fully determined"
	};
	return {
		code: "ok",
		summary: "active and trusted on this device",
		message: null
	};
}
function resolveMatrixRoomKeyBackupReadinessError(backup, opts) {
	const issue = resolveMatrixRoomKeyBackupIssue(backup);
	if (issue.code === "missing-server-backup") return opts.requireServerBackup ? "Matrix room key backup is missing on the homeserver." : null;
	if (issue.code === "ok") return null;
	if (issue.code === "untrusted-signature" && opts.allowUntrustedMatchingKey === true && backup.matchesDecryptionKey === true && backup.decryptionKeyCached === true) return null;
	if (issue.message) return `Matrix room key backup is not usable: ${issue.message}.`;
	return "Matrix room key backup is not usable on this device.";
}
//#endregion
export { resolveMatrixRoomKeyBackupReadinessError as n, resolveMatrixRoomKeyBackupIssue as t };
