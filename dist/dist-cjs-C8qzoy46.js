import { a as __toCommonJS, i as __require, t as __commonJSMin } from "./chunk-CNf5ZN-e.js";
import { n as init_client, t as client_exports } from "./client-Du4bZd9P.js";
import { Rt as config_exports, zt as init_config } from "./client-hKay7jF9.js";
//#region node_modules/@aws-sdk/credential-provider-web-identity/dist-cjs/fromWebToken.js
var require_fromWebToken = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.fromWebToken = void 0;
	const fromWebToken = (init) => async (awsIdentityProperties) => {
		init.logger?.debug("@aws-sdk/credential-provider-web-identity - fromWebToken");
		const { roleArn, roleSessionName, webIdentityToken, providerId, policyArns, policy, durationSeconds } = init;
		let { roleAssumerWithWebIdentity } = init;
		if (!roleAssumerWithWebIdentity) {
			const { getDefaultRoleAssumerWithWebIdentity } = await import("./sts-COigtJA9.js");
			roleAssumerWithWebIdentity = getDefaultRoleAssumerWithWebIdentity({
				...init.clientConfig,
				credentialProviderLogger: init.logger,
				parentClientConfig: {
					...awsIdentityProperties?.callerClientConfig,
					...init.parentClientConfig
				}
			}, init.clientPlugins);
		}
		return roleAssumerWithWebIdentity({
			RoleArn: roleArn,
			RoleSessionName: roleSessionName ?? `aws-sdk-js-session-${Date.now()}`,
			WebIdentityToken: webIdentityToken,
			ProviderId: providerId,
			PolicyArns: policyArns,
			Policy: policy,
			DurationSeconds: durationSeconds
		});
	};
	exports.fromWebToken = fromWebToken;
}));
//#endregion
//#region node_modules/@aws-sdk/credential-provider-web-identity/dist-cjs/fromTokenFile.js
var require_fromTokenFile = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.fromTokenFile = void 0;
	const client_1 = (init_client(), __toCommonJS(client_exports));
	const config_1 = (init_config(), __toCommonJS(config_exports));
	const node_fs_1 = __require("node:fs");
	const fromWebToken_1 = require_fromWebToken();
	const ENV_TOKEN_FILE = "AWS_WEB_IDENTITY_TOKEN_FILE";
	const ENV_ROLE_ARN = "AWS_ROLE_ARN";
	const ENV_ROLE_SESSION_NAME = "AWS_ROLE_SESSION_NAME";
	const fromTokenFile = (init = {}) => async (awsIdentityProperties) => {
		init.logger?.debug("@aws-sdk/credential-provider-web-identity - fromTokenFile");
		const webIdentityTokenFile = init?.webIdentityTokenFile ?? process.env[ENV_TOKEN_FILE];
		const roleArn = init?.roleArn ?? process.env[ENV_ROLE_ARN];
		const roleSessionName = init?.roleSessionName ?? process.env[ENV_ROLE_SESSION_NAME];
		if (!webIdentityTokenFile || !roleArn) throw new config_1.CredentialsProviderError("Web identity configuration not specified", { logger: init.logger });
		const credentials = await (0, fromWebToken_1.fromWebToken)({
			...init,
			webIdentityToken: config_1.externalDataInterceptor?.getTokenRecord?.()[webIdentityTokenFile] ?? (0, node_fs_1.readFileSync)(webIdentityTokenFile, { encoding: "ascii" }),
			roleArn,
			roleSessionName
		})(awsIdentityProperties);
		if (webIdentityTokenFile === process.env[ENV_TOKEN_FILE]) (0, client_1.setCredentialFeature)(credentials, "CREDENTIALS_ENV_VARS_STS_WEB_ID_TOKEN", "h");
		return credentials;
	};
	exports.fromTokenFile = fromTokenFile;
}));
//#endregion
//#region node_modules/@aws-sdk/credential-provider-web-identity/dist-cjs/index.js
var require_dist_cjs = /* @__PURE__ */ __commonJSMin(((exports) => {
	var fromTokenFile = require_fromTokenFile();
	var fromWebToken = require_fromWebToken();
	Object.prototype.hasOwnProperty.call(fromTokenFile, "__proto__") && !Object.prototype.hasOwnProperty.call(exports, "__proto__") && Object.defineProperty(exports, "__proto__", {
		enumerable: true,
		value: fromTokenFile["__proto__"]
	});
	Object.keys(fromTokenFile).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) exports[k] = fromTokenFile[k];
	});
	Object.prototype.hasOwnProperty.call(fromWebToken, "__proto__") && !Object.prototype.hasOwnProperty.call(exports, "__proto__") && Object.defineProperty(exports, "__proto__", {
		enumerable: true,
		value: fromWebToken["__proto__"]
	});
	Object.keys(fromWebToken).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) exports[k] = fromWebToken[k];
	});
}));
//#endregion
export default require_dist_cjs();
export {};
