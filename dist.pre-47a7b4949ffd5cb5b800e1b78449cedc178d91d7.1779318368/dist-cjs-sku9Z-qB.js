import { a as __toCommonJS, i as __require, t as __commonJSMin } from "./chunk-CNf5ZN-e.js";
import { c as tslib_es6_exports, s as init_tslib_es6 } from "./tslib.es6-DJxJwErw.js";
import { n as init_client, t as client_exports } from "./client-Du4bZd9P.js";
import { A as protocols_exports, Rt as config_exports, dt as init_serde, ft as serde_exports, k as init_protocols, zt as init_config } from "./client-hKay7jF9.js";
import { t as require_dist_cjs$1 } from "./dist-cjs-CVaUaZ1m.js";
//#region node_modules/@aws-sdk/credential-provider-http/dist-cjs/fromHttp/checkUrl.js
var require_checkUrl = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.checkUrl = void 0;
	const config_1 = (init_config(), __toCommonJS(config_exports));
	const ECS_CONTAINER_HOST = "169.254.170.2";
	const EKS_CONTAINER_HOST_IPv4 = "169.254.170.23";
	const EKS_CONTAINER_HOST_IPv6 = "[fd00:ec2::23]";
	const checkUrl = (url, logger) => {
		if (url.protocol === "https:") return;
		if (url.hostname === ECS_CONTAINER_HOST || url.hostname === EKS_CONTAINER_HOST_IPv4 || url.hostname === EKS_CONTAINER_HOST_IPv6) return;
		if (url.hostname.includes("[")) {
			if (url.hostname === "[::1]" || url.hostname === "[0000:0000:0000:0000:0000:0000:0000:0001]") return;
		} else {
			if (url.hostname === "localhost") return;
			const ipComponents = url.hostname.split(".");
			const inRange = (component) => {
				const num = parseInt(component, 10);
				return 0 <= num && num <= 255;
			};
			if (ipComponents[0] === "127" && inRange(ipComponents[1]) && inRange(ipComponents[2]) && inRange(ipComponents[3]) && ipComponents.length === 4) return;
		}
		throw new config_1.CredentialsProviderError(`URL not accepted. It must either be HTTPS or match one of the following:
  - loopback CIDR 127.0.0.0/8 or [::1/128]
  - ECS container host 169.254.170.2
  - EKS container host 169.254.170.23 or [fd00:ec2::23]`, { logger });
	};
	exports.checkUrl = checkUrl;
}));
//#endregion
//#region node_modules/@aws-sdk/credential-provider-http/dist-cjs/fromHttp/requestHelpers.js
var require_requestHelpers = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.createGetRequest = createGetRequest;
	exports.getCredentials = getCredentials;
	const config_1 = (init_config(), __toCommonJS(config_exports));
	const protocols_1 = (init_protocols(), __toCommonJS(protocols_exports));
	const serde_1 = (init_serde(), __toCommonJS(serde_exports));
	const serde_2 = (init_serde(), __toCommonJS(serde_exports));
	function createGetRequest(url) {
		return new protocols_1.HttpRequest({
			protocol: url.protocol,
			hostname: url.hostname,
			port: Number(url.port),
			path: url.pathname,
			query: Array.from(url.searchParams.entries()).reduce((acc, [k, v]) => {
				acc[k] = v;
				return acc;
			}, {}),
			fragment: url.hash
		});
	}
	async function getCredentials(response, logger) {
		const str = await (0, serde_2.sdkStreamMixin)(response.body).transformToString();
		if (response.statusCode === 200) {
			const parsed = JSON.parse(str);
			if (typeof parsed.AccessKeyId !== "string" || typeof parsed.SecretAccessKey !== "string" || typeof parsed.Token !== "string" || typeof parsed.Expiration !== "string") throw new config_1.CredentialsProviderError("HTTP credential provider response not of the required format, an object matching: { AccessKeyId: string, SecretAccessKey: string, Token: string, Expiration: string(rfc3339) }", { logger });
			return {
				accessKeyId: parsed.AccessKeyId,
				secretAccessKey: parsed.SecretAccessKey,
				sessionToken: parsed.Token,
				expiration: (0, serde_1.parseRfc3339DateTime)(parsed.Expiration)
			};
		}
		if (response.statusCode >= 400 && response.statusCode < 500) {
			let parsedBody = {};
			try {
				parsedBody = JSON.parse(str);
			} catch (e) {}
			throw Object.assign(new config_1.CredentialsProviderError(`Server responded with status: ${response.statusCode}`, { logger }), {
				Code: parsedBody.Code,
				Message: parsedBody.Message
			});
		}
		throw new config_1.CredentialsProviderError(`Server responded with status: ${response.statusCode}`, { logger });
	}
}));
//#endregion
//#region node_modules/@aws-sdk/credential-provider-http/dist-cjs/fromHttp/retry-wrapper.js
var require_retry_wrapper = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.retryWrapper = void 0;
	const retryWrapper = (toRetry, maxRetries, delayMs) => {
		return async () => {
			for (let i = 0; i < maxRetries; ++i) try {
				return await toRetry();
			} catch (e) {
				await new Promise((resolve) => setTimeout(resolve, delayMs));
			}
			return await toRetry();
		};
	};
	exports.retryWrapper = retryWrapper;
}));
//#endregion
//#region node_modules/@aws-sdk/credential-provider-http/dist-cjs/fromHttp/fromHttp.js
var require_fromHttp = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.fromHttp = void 0;
	const tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
	const client_1 = (init_client(), __toCommonJS(client_exports));
	const config_1 = (init_config(), __toCommonJS(config_exports));
	const node_http_handler_1 = require_dist_cjs$1();
	const promises_1 = tslib_1.__importDefault(__require("node:fs/promises"));
	const checkUrl_1 = require_checkUrl();
	const requestHelpers_1 = require_requestHelpers();
	const retry_wrapper_1 = require_retry_wrapper();
	const AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI";
	const DEFAULT_LINK_LOCAL_HOST = "http://169.254.170.2";
	const AWS_CONTAINER_CREDENTIALS_FULL_URI = "AWS_CONTAINER_CREDENTIALS_FULL_URI";
	const AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE = "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE";
	const AWS_CONTAINER_AUTHORIZATION_TOKEN = "AWS_CONTAINER_AUTHORIZATION_TOKEN";
	const fromHttp = (options = {}) => {
		options.logger?.debug("@aws-sdk/credential-provider-http - fromHttp");
		let host;
		const relative = options.awsContainerCredentialsRelativeUri ?? process.env[AWS_CONTAINER_CREDENTIALS_RELATIVE_URI];
		const full = options.awsContainerCredentialsFullUri ?? process.env[AWS_CONTAINER_CREDENTIALS_FULL_URI];
		const token = options.awsContainerAuthorizationToken ?? process.env[AWS_CONTAINER_AUTHORIZATION_TOKEN];
		const tokenFile = options.awsContainerAuthorizationTokenFile ?? process.env[AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE];
		const warn = options.logger?.constructor?.name === "NoOpLogger" || !options.logger?.warn ? console.warn : options.logger.warn.bind(options.logger);
		if (relative && full) {
			warn("@aws-sdk/credential-provider-http: you have set both awsContainerCredentialsRelativeUri and awsContainerCredentialsFullUri.");
			warn("awsContainerCredentialsFullUri will take precedence.");
		}
		if (token && tokenFile) {
			warn("@aws-sdk/credential-provider-http: you have set both awsContainerAuthorizationToken and awsContainerAuthorizationTokenFile.");
			warn("awsContainerAuthorizationToken will take precedence.");
		}
		if (full) host = full;
		else if (relative) host = `${DEFAULT_LINK_LOCAL_HOST}${relative}`;
		else throw new config_1.CredentialsProviderError(`No HTTP credential provider host provided.
Set AWS_CONTAINER_CREDENTIALS_FULL_URI or AWS_CONTAINER_CREDENTIALS_RELATIVE_URI.`, { logger: options.logger });
		const url = new URL(host);
		(0, checkUrl_1.checkUrl)(url, options.logger);
		const requestHandler = node_http_handler_1.NodeHttpHandler.create({
			requestTimeout: options.timeout ?? 1e3,
			connectionTimeout: options.timeout ?? 1e3
		});
		return (0, retry_wrapper_1.retryWrapper)(async () => {
			const request = (0, requestHelpers_1.createGetRequest)(url);
			if (token) request.headers.Authorization = token;
			else if (tokenFile) request.headers.Authorization = (await promises_1.default.readFile(tokenFile)).toString();
			try {
				const result = await requestHandler.handle(request);
				return (0, requestHelpers_1.getCredentials)(result.response).then((creds) => (0, client_1.setCredentialFeature)(creds, "CREDENTIALS_HTTP", "z"));
			} catch (e) {
				throw new config_1.CredentialsProviderError(String(e), { logger: options.logger });
			}
		}, options.maxRetries ?? 3, options.timeout ?? 1e3);
	};
	exports.fromHttp = fromHttp;
}));
//#endregion
//#region node_modules/@aws-sdk/credential-provider-http/dist-cjs/index.js
var require_dist_cjs = /* @__PURE__ */ __commonJSMin(((exports) => {
	exports.fromHttp = require_fromHttp().fromHttp;
}));
//#endregion
export default require_dist_cjs();
export {};
