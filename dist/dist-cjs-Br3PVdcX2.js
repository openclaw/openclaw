import { a as __toCommonJS, i as __require, t as __commonJSMin } from "./chunk-CNf5ZN-e.js";
import { n as init_client, t as client_exports } from "./client-Du4bZd9P.js";
import { Rt as config_exports, zt as init_config } from "./client-hKay7jF9.js";
//#region node_modules/@aws-sdk/credential-provider-process/dist-cjs/index.js
var require_dist_cjs = /* @__PURE__ */ __commonJSMin(((exports) => {
	var config = (init_config(), __toCommonJS(config_exports));
	var node_child_process = __require("node:child_process");
	var node_util = __require("node:util");
	var client = (init_client(), __toCommonJS(client_exports));
	const getValidatedProcessCredentials = (profileName, data, profiles) => {
		if (data.Version !== 1) throw Error(`Profile ${profileName} credential_process did not return Version 1.`);
		if (data.AccessKeyId === void 0 || data.SecretAccessKey === void 0) throw Error(`Profile ${profileName} credential_process returned invalid credentials.`);
		if (data.Expiration) {
			const currentTime = /* @__PURE__ */ new Date();
			if (new Date(data.Expiration) < currentTime) throw Error(`Profile ${profileName} credential_process returned expired credentials.`);
		}
		let accountId = data.AccountId;
		if (!accountId && profiles?.[profileName]?.aws_account_id) accountId = profiles[profileName].aws_account_id;
		const credentials = {
			accessKeyId: data.AccessKeyId,
			secretAccessKey: data.SecretAccessKey,
			...data.SessionToken && { sessionToken: data.SessionToken },
			...data.Expiration && { expiration: new Date(data.Expiration) },
			...data.CredentialScope && { credentialScope: data.CredentialScope },
			...accountId && { accountId }
		};
		client.setCredentialFeature(credentials, "CREDENTIALS_PROCESS", "w");
		return credentials;
	};
	const resolveProcessCredentials = async (profileName, profiles, logger) => {
		const profile = profiles[profileName];
		if (profiles[profileName]) {
			const credentialProcess = profile["credential_process"];
			if (credentialProcess !== void 0) {
				const execPromise = node_util.promisify(config.externalDataInterceptor?.getTokenRecord?.().exec ?? node_child_process.exec);
				try {
					const { stdout } = await execPromise(credentialProcess);
					let data;
					try {
						data = JSON.parse(stdout.trim());
					} catch {
						throw Error(`Profile ${profileName} credential_process returned invalid JSON.`);
					}
					return getValidatedProcessCredentials(profileName, data, profiles);
				} catch (error) {
					throw new config.CredentialsProviderError(error.message, { logger });
				}
			} else throw new config.CredentialsProviderError(`Profile ${profileName} did not contain credential_process.`, { logger });
		} else throw new config.CredentialsProviderError(`Profile ${profileName} could not be found in shared credentials file.`, { logger });
	};
	const fromProcess = (init = {}) => async ({ callerClientConfig } = {}) => {
		init.logger?.debug("@aws-sdk/credential-provider-process - fromProcess");
		const profiles = await config.parseKnownFiles(init);
		return resolveProcessCredentials(config.getProfileName({ profile: init.profile ?? callerClientConfig?.profile }), profiles, init.logger);
	};
	exports.fromProcess = fromProcess;
}));
//#endregion
export default require_dist_cjs();
export {};
