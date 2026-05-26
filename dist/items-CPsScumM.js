import { d as markMigrationItemSkipped, l as markMigrationItemConflict, o as createMigrationItem, u as markMigrationItemError } from "./migration-DGUrqTK8.js";
import { c as readString } from "./helpers-B_eVYvP7.js";
//#region extensions/migrate-hermes/items.ts
const HERMES_REASON_ALREADY_CONFIGURED = "already configured";
const HERMES_REASON_DEFAULT_MODEL_CONFIGURED = "default model already configured";
const HERMES_REASON_INCLUDE_SECRETS = "use --include-secrets to import";
const HERMES_REASON_AUTH_PROFILE_EXISTS = "auth profile exists";
const HERMES_REASON_CONFIG_RUNTIME_UNAVAILABLE = "config runtime unavailable";
const HERMES_REASON_MISSING_SECRET_METADATA = "missing secret metadata";
const HERMES_REASON_SECRET_NO_LONGER_PRESENT = "secret no longer present";
const HERMES_REASON_AUTH_PROFILE_WRITE_FAILED = "failed to write auth profile";
function createHermesModelItem(params) {
	const alreadyConfigured = params.currentModel === params.model;
	const conflict = Boolean(params.currentModel && !params.overwrite && !alreadyConfigured);
	return createMigrationItem({
		id: "config:default-model",
		kind: "config",
		action: alreadyConfigured ? "skip" : "update",
		target: "agents.defaults.model",
		status: alreadyConfigured ? "skipped" : conflict ? "conflict" : "planned",
		reason: alreadyConfigured ? HERMES_REASON_ALREADY_CONFIGURED : conflict ? HERMES_REASON_DEFAULT_MODEL_CONFIGURED : void 0,
		details: { model: params.model }
	});
}
function readHermesModelDetails(item) {
	const model = readString(item.details?.model);
	return model ? { model } : void 0;
}
function createHermesSecretItem(params) {
	const skipped = !params.includeSecrets;
	const conflict = Boolean(params.existsAlready && !skipped);
	return createMigrationItem({
		id: params.id,
		kind: "secret",
		action: skipped ? "skip" : "create",
		source: params.source,
		target: params.target,
		status: skipped ? "skipped" : conflict ? "conflict" : "planned",
		sensitive: true,
		reason: skipped ? HERMES_REASON_INCLUDE_SECRETS : conflict ? HERMES_REASON_AUTH_PROFILE_EXISTS : void 0,
		details: params.details
	});
}
function readHermesSecretDetails(item) {
	const envVar = readString(item.details?.envVar);
	const provider = readString(item.details?.provider);
	const profileId = readString(item.details?.profileId);
	return envVar && provider && profileId ? {
		envVar,
		provider,
		profileId
	} : void 0;
}
function hermesItemConflict(item, reason) {
	return markMigrationItemConflict(item, reason);
}
function hermesItemError(item, reason) {
	return markMigrationItemError(item, reason);
}
function hermesItemSkipped(item, reason) {
	return markMigrationItemSkipped(item, reason);
}
//#endregion
export { HERMES_REASON_DEFAULT_MODEL_CONFIGURED as a, HERMES_REASON_SECRET_NO_LONGER_PRESENT as c, hermesItemConflict as d, hermesItemError as f, readHermesSecretDetails as h, HERMES_REASON_CONFIG_RUNTIME_UNAVAILABLE as i, createHermesModelItem as l, readHermesModelDetails as m, HERMES_REASON_AUTH_PROFILE_EXISTS as n, HERMES_REASON_INCLUDE_SECRETS as o, hermesItemSkipped as p, HERMES_REASON_AUTH_PROFILE_WRITE_FAILED as r, HERMES_REASON_MISSING_SECRET_METADATA as s, HERMES_REASON_ALREADY_CONFIGURED as t, createHermesSecretItem as u };
