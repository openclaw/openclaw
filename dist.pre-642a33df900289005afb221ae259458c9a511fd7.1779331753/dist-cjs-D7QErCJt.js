import { a as __toCommonJS, t as __commonJSMin } from "./chunk-CNf5ZN-e.js";
import { n as init_client, t as client_exports } from "./client-Du4bZd9P.js";
import { Rt as config_exports, zt as init_config } from "./client-hKay7jF9.js";
//#region node_modules/@aws-sdk/credential-provider-env/dist-cjs/index.js
var require_dist_cjs = /* @__PURE__ */ __commonJSMin(((exports) => {
	var client = (init_client(), __toCommonJS(client_exports));
	var config = (init_config(), __toCommonJS(config_exports));
	const ENV_KEY = "AWS_ACCESS_KEY_ID";
	const ENV_SECRET = "AWS_SECRET_ACCESS_KEY";
	const ENV_SESSION = "AWS_SESSION_TOKEN";
	const ENV_EXPIRATION = "AWS_CREDENTIAL_EXPIRATION";
	const ENV_CREDENTIAL_SCOPE = "AWS_CREDENTIAL_SCOPE";
	const ENV_ACCOUNT_ID = "AWS_ACCOUNT_ID";
	const fromEnv = (init) => async () => {
		init?.logger?.debug("@aws-sdk/credential-provider-env - fromEnv");
		const accessKeyId = process.env[ENV_KEY];
		const secretAccessKey = process.env[ENV_SECRET];
		const sessionToken = process.env[ENV_SESSION];
		const expiry = process.env[ENV_EXPIRATION];
		const credentialScope = process.env[ENV_CREDENTIAL_SCOPE];
		const accountId = process.env[ENV_ACCOUNT_ID];
		if (accessKeyId && secretAccessKey) {
			const credentials = {
				accessKeyId,
				secretAccessKey,
				...sessionToken && { sessionToken },
				...expiry && { expiration: new Date(expiry) },
				...credentialScope && { credentialScope },
				...accountId && { accountId }
			};
			client.setCredentialFeature(credentials, "CREDENTIALS_ENV_VARS", "g");
			return credentials;
		}
		throw new config.CredentialsProviderError("Unable to find environment variable credentials.", { logger: init?.logger });
	};
	exports.ENV_ACCOUNT_ID = ENV_ACCOUNT_ID;
	exports.ENV_CREDENTIAL_SCOPE = ENV_CREDENTIAL_SCOPE;
	exports.ENV_EXPIRATION = ENV_EXPIRATION;
	exports.ENV_KEY = ENV_KEY;
	exports.ENV_SECRET = ENV_SECRET;
	exports.ENV_SESSION = ENV_SESSION;
	exports.fromEnv = fromEnv;
}));
//#endregion
export { require_dist_cjs as t };
