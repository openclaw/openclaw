import { i as isKnownSecretTargetId } from "./target-registry-BBvvwcuS.js";
import { Mt as validateSecretsResolveParams, Ni as ErrorCodes, Nt as validateSecretsResolveResult, Pi as errorShape } from "./protocol-QC2mQFMN.js";
//#region src/gateway/server-methods/secrets.ts
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
function invalidSecretsResolveField(errors) {
	for (const issue of errors ?? []) if (issue.instancePath === "/commandName" || issue.instancePath === "" && String(issue.params?.missingProperty) === "commandName") return "commandName";
	return "targetIds";
}
function createSecretsHandlers(params) {
	return {
		"secrets.reload": async ({ respond }) => {
			try {
				respond(true, {
					ok: true,
					warningCount: (await params.reloadSecrets()).warningCount
				});
			} catch (error) {
				params.log?.warn?.(`secrets.reload failed: ${errorMessage(error)}`);
				respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, "secrets.reload failed"));
			}
		},
		"secrets.resolve": async ({ params: requestParams, respond }) => {
			if (!validateSecretsResolveParams(requestParams)) {
				const field = invalidSecretsResolveField(validateSecretsResolveParams.errors);
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid secrets.resolve params: ${field}`));
				return;
			}
			const commandName = requestParams.commandName.trim();
			if (!commandName) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "invalid secrets.resolve params: commandName"));
				return;
			}
			const targetIds = requestParams.targetIds.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
			for (const targetId of targetIds) if (!isKnownSecretTargetId(targetId)) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid secrets.resolve params: unknown target id "${String(targetId)}"`));
				return;
			}
			try {
				const result = await params.resolveSecrets({
					commandName,
					targetIds
				});
				const payload = {
					ok: true,
					assignments: result.assignments,
					diagnostics: result.diagnostics,
					inactiveRefPaths: result.inactiveRefPaths
				};
				if (!validateSecretsResolveResult(payload)) throw new Error("secrets.resolve returned invalid payload.");
				respond(true, payload);
			} catch (error) {
				params.log?.warn?.(`secrets.resolve failed: ${errorMessage(error)}`);
				respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, "secrets.resolve failed"));
			}
		}
	};
}
//#endregion
export { createSecretsHandlers };
