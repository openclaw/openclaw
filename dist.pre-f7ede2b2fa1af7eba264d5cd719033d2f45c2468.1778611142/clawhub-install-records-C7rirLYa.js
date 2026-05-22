//#region src/plugins/clawhub-install-records.ts
function buildClawHubPluginInstallRecordFields(fields) {
	return {
		source: "clawhub",
		clawhubUrl: fields.clawhubUrl,
		clawhubPackage: fields.clawhubPackage,
		clawhubFamily: fields.clawhubFamily,
		...fields.clawhubChannel ? { clawhubChannel: fields.clawhubChannel } : {},
		...fields.version ? { version: fields.version } : {},
		...fields.integrity ? { integrity: fields.integrity } : {},
		...fields.resolvedAt ? { resolvedAt: fields.resolvedAt } : {},
		...fields.installedAt ? { installedAt: fields.installedAt } : {},
		...fields.artifactKind ? { artifactKind: fields.artifactKind } : {},
		...fields.artifactFormat ? { artifactFormat: fields.artifactFormat } : {},
		...fields.npmIntegrity ? { npmIntegrity: fields.npmIntegrity } : {},
		...fields.npmShasum ? { npmShasum: fields.npmShasum } : {},
		...fields.npmTarballName ? { npmTarballName: fields.npmTarballName } : {},
		...fields.clawpackSha256 ? { clawpackSha256: fields.clawpackSha256 } : {},
		...fields.clawpackSpecVersion !== void 0 ? { clawpackSpecVersion: fields.clawpackSpecVersion } : {},
		...fields.clawpackManifestSha256 ? { clawpackManifestSha256: fields.clawpackManifestSha256 } : {},
		...fields.clawpackSize !== void 0 ? { clawpackSize: fields.clawpackSize } : {}
	};
}
//#endregion
export { buildClawHubPluginInstallRecordFields as t };
