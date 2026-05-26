import { a as __toCommonJS, i as __require, n as __esmMin, r as __exportAll, t as __commonJSMin } from "./chunk-HkwdBwDg.js";
import { A as getSchemaSerdePlugin, E as init_schema, O as TypeRegistry } from "./protocols-CO3NMy6S.js";
import { t as require_dist_cjs$2 } from "./dist-cjs-DQR3Meck.js";
import { c as emitWarningIfUnsupportedVersion$1, i as require_dist_cjs$4, n as client_exports, r as init_client, t as require_dist_cjs$3 } from "./dist-cjs-DS9W42km.js";
import { B as require_dist_cjs$10, D as getHttpSigningPlugin, E as DefaultIdentityProviderConfig, F as require_dist_cjs$9, I as require_dist_cjs$21, L as require_dist_cjs$20, O as getHttpAuthSchemeEndpointRuleSetPlugin, P as AwsRestJsonProtocol, R as require_dist_cjs$19, S as require_dist_cjs$6, T as NoAuthSigner, _ as require_dist_cjs$23, a as require_dist_cjs$13, b as require_dist_cjs$7, c as init_httpAuthSchemes, f as NODE_AUTH_SCHEME_PREFERENCE_OPTIONS, g as require_dist_cjs$24, h as require_dist_cjs$14, i as require_dist_cjs$15, j as init_protocols, l as resolveAwsSdkSigV4Config, m as AwsSdkSigV4Signer, n as require_dist_cjs$17, o as require_dist_cjs$11, r as require_dist_cjs$16, s as httpAuthSchemes_exports, t as require_dist_cjs$18, v as require_dist_cjs$12, w as init_dist_es, x as require_dist_cjs$8, y as require_dist_cjs$22, z as require_dist_cjs$5 } from "./dist-cjs-D0pP6SUX.js";
import { n as require_dist_cjs$25, t as require_dist_cjs$26 } from "./dist-cjs-DDGLQYvl.js";
import { t as require_dist_cjs$27 } from "./dist-cjs-CrTY3Efo.js";
import { t as version } from "./package-CNqrm-wp.js";
//#region node_modules/@aws-sdk/credential-provider-sso/node_modules/@aws-sdk/token-providers/dist-cjs/index.js
var require_dist_cjs$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var client = (init_client(), __toCommonJS(client_exports));
	var httpAuthSchemes = (init_httpAuthSchemes(), __toCommonJS(httpAuthSchemes_exports));
	var propertyProvider = require_dist_cjs$3();
	var sharedIniFileLoader = require_dist_cjs$27();
	var node_fs = __require("node:fs");
	const fromEnvSigningName = ({ logger, signingName } = {}) => async () => {
		logger?.debug?.("@aws-sdk/token-providers - fromEnvSigningName");
		if (!signingName) throw new propertyProvider.TokenProviderError("Please pass 'signingName' to compute environment variable key", { logger });
		const bearerTokenKey = httpAuthSchemes.getBearerTokenEnvKey(signingName);
		if (!(bearerTokenKey in process.env)) throw new propertyProvider.TokenProviderError(`Token not present in '${bearerTokenKey}' environment variable`, { logger });
		const token = { token: process.env[bearerTokenKey] };
		client.setTokenFeature(token, "BEARER_SERVICE_ENV_VARS", "3");
		return token;
	};
	const EXPIRE_WINDOW_MS = 300 * 1e3;
	const REFRESH_MESSAGE = `To refresh this SSO session run 'aws sso login' with the corresponding profile.`;
	const getSsoOidcClient = async (ssoRegion, init = {}, callerClientConfig) => {
		const { SSOOIDCClient } = await import("./sso-oidc-DWDABzN1.js");
		const coalesce = (prop) => init.clientConfig?.[prop] ?? init.parentClientConfig?.[prop] ?? callerClientConfig?.[prop];
		return new SSOOIDCClient(Object.assign({}, init.clientConfig ?? {}, {
			region: ssoRegion ?? init.clientConfig?.region,
			logger: coalesce("logger"),
			userAgentAppId: coalesce("userAgentAppId")
		}));
	};
	const getNewSsoOidcToken = async (ssoToken, ssoRegion, init = {}, callerClientConfig) => {
		const { CreateTokenCommand } = await import("./sso-oidc-DWDABzN1.js");
		return (await getSsoOidcClient(ssoRegion, init, callerClientConfig)).send(new CreateTokenCommand({
			clientId: ssoToken.clientId,
			clientSecret: ssoToken.clientSecret,
			refreshToken: ssoToken.refreshToken,
			grantType: "refresh_token"
		}));
	};
	const validateTokenExpiry = (token) => {
		if (token.expiration && token.expiration.getTime() < Date.now()) throw new propertyProvider.TokenProviderError(`Token is expired. ${REFRESH_MESSAGE}`, false);
	};
	const validateTokenKey = (key, value, forRefresh = false) => {
		if (typeof value === "undefined") throw new propertyProvider.TokenProviderError(`Value not present for '${key}' in SSO Token${forRefresh ? ". Cannot refresh" : ""}. ${REFRESH_MESSAGE}`, false);
	};
	const { writeFile } = node_fs.promises;
	const writeSSOTokenToFile = (id, ssoToken) => {
		return writeFile(sharedIniFileLoader.getSSOTokenFilepath(id), JSON.stringify(ssoToken, null, 2));
	};
	const lastRefreshAttemptTime = /* @__PURE__ */ new Date(0);
	const fromSso = (init = {}) => async ({ callerClientConfig } = {}) => {
		init.logger?.debug("@aws-sdk/token-providers - fromSso");
		const profiles = await sharedIniFileLoader.parseKnownFiles(init);
		const profileName = sharedIniFileLoader.getProfileName({ profile: init.profile ?? callerClientConfig?.profile });
		const profile = profiles[profileName];
		if (!profile) throw new propertyProvider.TokenProviderError(`Profile '${profileName}' could not be found in shared credentials file.`, false);
		else if (!profile["sso_session"]) throw new propertyProvider.TokenProviderError(`Profile '${profileName}' is missing required property 'sso_session'.`);
		const ssoSessionName = profile["sso_session"];
		const ssoSession = (await sharedIniFileLoader.loadSsoSessionData(init))[ssoSessionName];
		if (!ssoSession) throw new propertyProvider.TokenProviderError(`Sso session '${ssoSessionName}' could not be found in shared credentials file.`, false);
		for (const ssoSessionRequiredKey of ["sso_start_url", "sso_region"]) if (!ssoSession[ssoSessionRequiredKey]) throw new propertyProvider.TokenProviderError(`Sso session '${ssoSessionName}' is missing required property '${ssoSessionRequiredKey}'.`, false);
		ssoSession["sso_start_url"];
		const ssoRegion = ssoSession["sso_region"];
		let ssoToken;
		try {
			ssoToken = await sharedIniFileLoader.getSSOTokenFromFile(ssoSessionName);
		} catch (e) {
			throw new propertyProvider.TokenProviderError(`The SSO session token associated with profile=${profileName} was not found or is invalid. ${REFRESH_MESSAGE}`, false);
		}
		validateTokenKey("accessToken", ssoToken.accessToken);
		validateTokenKey("expiresAt", ssoToken.expiresAt);
		const { accessToken, expiresAt } = ssoToken;
		const existingToken = {
			token: accessToken,
			expiration: new Date(expiresAt)
		};
		if (existingToken.expiration.getTime() - Date.now() > EXPIRE_WINDOW_MS) return existingToken;
		if (Date.now() - lastRefreshAttemptTime.getTime() < 30 * 1e3) {
			validateTokenExpiry(existingToken);
			return existingToken;
		}
		validateTokenKey("clientId", ssoToken.clientId, true);
		validateTokenKey("clientSecret", ssoToken.clientSecret, true);
		validateTokenKey("refreshToken", ssoToken.refreshToken, true);
		try {
			lastRefreshAttemptTime.setTime(Date.now());
			const newSsoOidcToken = await getNewSsoOidcToken(ssoToken, ssoRegion, init, callerClientConfig);
			validateTokenKey("accessToken", newSsoOidcToken.accessToken);
			validateTokenKey("expiresIn", newSsoOidcToken.expiresIn);
			const newTokenExpiration = new Date(Date.now() + newSsoOidcToken.expiresIn * 1e3);
			try {
				await writeSSOTokenToFile(ssoSessionName, {
					...ssoToken,
					accessToken: newSsoOidcToken.accessToken,
					expiresAt: newTokenExpiration.toISOString(),
					refreshToken: newSsoOidcToken.refreshToken
				});
			} catch (error) {}
			return {
				token: newSsoOidcToken.accessToken,
				expiration: newTokenExpiration
			};
		} catch (error) {
			validateTokenExpiry(existingToken);
			return existingToken;
		}
	};
	const fromStatic = ({ token, logger }) => async () => {
		logger?.debug("@aws-sdk/token-providers - fromStatic");
		if (!token || !token.token) throw new propertyProvider.TokenProviderError(`Please pass a valid token to fromStatic`, false);
		return token;
	};
	const nodeProvider = (init = {}) => propertyProvider.memoize(propertyProvider.chain(fromSso(init), async () => {
		throw new propertyProvider.TokenProviderError("Could not load token from any providers", false);
	}), (token) => token.expiration !== void 0 && token.expiration.getTime() - Date.now() < 3e5, (token) => token.expiration !== void 0);
	exports.fromEnvSigningName = fromEnvSigningName;
	exports.fromSso = fromSso;
	exports.fromStatic = fromStatic;
	exports.nodeProvider = nodeProvider;
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sso/auth/httpAuthSchemeProvider.js
function createAwsAuthSigv4HttpAuthOption(authParameters) {
	return {
		schemeId: "aws.auth#sigv4",
		signingProperties: {
			name: "awsssoportal",
			region: authParameters.region
		},
		propertiesExtractor: (config, context) => ({ signingProperties: {
			config,
			context
		} })
	};
}
function createSmithyApiNoAuthHttpAuthOption(authParameters) {
	return { schemeId: "smithy.api#noAuth" };
}
var import_dist_cjs$33, defaultSSOHttpAuthSchemeParametersProvider, defaultSSOHttpAuthSchemeProvider, resolveHttpAuthSchemeConfig;
var init_httpAuthSchemeProvider = __esmMin((() => {
	init_httpAuthSchemes();
	import_dist_cjs$33 = require_dist_cjs$5();
	defaultSSOHttpAuthSchemeParametersProvider = async (config, context, input) => {
		return {
			operation: (0, import_dist_cjs$33.getSmithyContext)(context).operation,
			region: await (0, import_dist_cjs$33.normalizeProvider)(config.region)() || (() => {
				throw new Error("expected `region` to be configured for `aws.auth#sigv4`");
			})()
		};
	};
	defaultSSOHttpAuthSchemeProvider = (authParameters) => {
		const options = [];
		switch (authParameters.operation) {
			case "GetRoleCredentials":
				options.push(createSmithyApiNoAuthHttpAuthOption(authParameters));
				break;
			default: options.push(createAwsAuthSigv4HttpAuthOption(authParameters));
		}
		return options;
	};
	resolveHttpAuthSchemeConfig = (config) => {
		const config_0 = resolveAwsSdkSigV4Config(config);
		return Object.assign(config_0, { authSchemePreference: (0, import_dist_cjs$33.normalizeProvider)(config.authSchemePreference ?? []) });
	};
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sso/endpoint/EndpointParameters.js
var resolveClientEndpointParameters, commonParams;
var init_EndpointParameters = __esmMin((() => {
	resolveClientEndpointParameters = (options) => {
		return Object.assign(options, {
			useDualstackEndpoint: options.useDualstackEndpoint ?? false,
			useFipsEndpoint: options.useFipsEndpoint ?? false,
			defaultSigningName: "awsssoportal"
		});
	};
	commonParams = {
		UseFIPS: {
			type: "builtInParams",
			name: "useFipsEndpoint"
		},
		Endpoint: {
			type: "builtInParams",
			name: "endpoint"
		},
		Region: {
			type: "builtInParams",
			name: "region"
		},
		UseDualStack: {
			type: "builtInParams",
			name: "useDualstackEndpoint"
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sso/endpoint/bdd.js
var import_dist_cjs$32, k, a, b, c, d, e, f, g, h, i, j, _data, root, r, nodes, bdd;
var init_bdd = __esmMin((() => {
	import_dist_cjs$32 = require_dist_cjs$6();
	k = "ref";
	a = -1, b = true, c = "isSet", d = "PartitionResult", e = "booleanEquals", f = "getAttr", g = { [k]: "Endpoint" }, h = { [k]: d }, i = {}, j = [{ [k]: "Region" }];
	_data = {
		conditions: [
			[c, [g]],
			[c, j],
			[
				"aws.partition",
				j,
				d
			],
			[e, [{ [k]: "UseFIPS" }, b]],
			[e, [{ [k]: "UseDualStack" }, b]],
			[e, [{
				fn: f,
				argv: [h, "supportsDualStack"]
			}, b]],
			[e, [{
				fn: f,
				argv: [h, "supportsFIPS"]
			}, b]],
			["stringEquals", [{
				fn: f,
				argv: [h, "name"]
			}, "aws-us-gov"]]
		],
		results: [
			[a],
			[a, "Invalid Configuration: FIPS and custom endpoint are not supported"],
			[a, "Invalid Configuration: Dualstack and custom endpoint are not supported"],
			[g, i],
			["https://portal.sso-fips.{Region}.{PartitionResult#dualStackDnsSuffix}", i],
			[a, "FIPS and DualStack are enabled, but this partition does not support one or both"],
			["https://portal.sso.{Region}.amazonaws.com", i],
			["https://portal.sso-fips.{Region}.{PartitionResult#dnsSuffix}", i],
			[a, "FIPS is enabled but this partition does not support FIPS"],
			["https://portal.sso.{Region}.{PartitionResult#dualStackDnsSuffix}", i],
			[a, "DualStack is enabled but this partition does not support DualStack"],
			["https://portal.sso.{Region}.{PartitionResult#dnsSuffix}", i],
			[a, "Invalid Configuration: Missing Region"]
		]
	};
	root = 2;
	r = 1e8;
	nodes = new Int32Array([
		-1,
		1,
		-1,
		0,
		13,
		3,
		1,
		4,
		r + 12,
		2,
		5,
		r + 12,
		3,
		8,
		6,
		4,
		7,
		r + 11,
		5,
		r + 9,
		r + 10,
		4,
		11,
		9,
		6,
		10,
		r + 8,
		7,
		r + 6,
		r + 7,
		5,
		12,
		r + 5,
		6,
		r + 4,
		r + 5,
		3,
		r + 1,
		14,
		4,
		r + 2,
		r + 3
	]);
	bdd = import_dist_cjs$32.BinaryDecisionDiagram.from(nodes, root, _data.conditions, _data.results);
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sso/endpoint/endpointResolver.js
var import_dist_cjs$30, import_dist_cjs$31, cache, defaultEndpointResolver;
var init_endpointResolver = __esmMin((() => {
	import_dist_cjs$30 = require_dist_cjs$7();
	import_dist_cjs$31 = require_dist_cjs$6();
	init_bdd();
	cache = new import_dist_cjs$31.EndpointCache({
		size: 50,
		params: [
			"Endpoint",
			"Region",
			"UseDualStack",
			"UseFIPS"
		]
	});
	defaultEndpointResolver = (endpointParams, context = {}) => {
		return cache.get(endpointParams, () => (0, import_dist_cjs$31.decideEndpoint)(bdd, {
			endpointParams,
			logger: context.logger
		}));
	};
	import_dist_cjs$31.customEndpointFunctions.aws = import_dist_cjs$30.awsEndpointFunctions;
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sso/models/SSOServiceException.js
var import_dist_cjs$29, SSOServiceException;
var init_SSOServiceException = __esmMin((() => {
	import_dist_cjs$29 = require_dist_cjs$25();
	SSOServiceException = class SSOServiceException extends import_dist_cjs$29.ServiceException {
		constructor(options) {
			super(options);
			Object.setPrototypeOf(this, SSOServiceException.prototype);
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sso/models/errors.js
var InvalidRequestException, ResourceNotFoundException, TooManyRequestsException, UnauthorizedException;
var init_errors = __esmMin((() => {
	init_SSOServiceException();
	InvalidRequestException = class InvalidRequestException extends SSOServiceException {
		name = "InvalidRequestException";
		$fault = "client";
		constructor(opts) {
			super({
				name: "InvalidRequestException",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, InvalidRequestException.prototype);
		}
	};
	ResourceNotFoundException = class ResourceNotFoundException extends SSOServiceException {
		name = "ResourceNotFoundException";
		$fault = "client";
		constructor(opts) {
			super({
				name: "ResourceNotFoundException",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, ResourceNotFoundException.prototype);
		}
	};
	TooManyRequestsException = class TooManyRequestsException extends SSOServiceException {
		name = "TooManyRequestsException";
		$fault = "client";
		constructor(opts) {
			super({
				name: "TooManyRequestsException",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, TooManyRequestsException.prototype);
		}
	};
	UnauthorizedException = class UnauthorizedException extends SSOServiceException {
		name = "UnauthorizedException";
		$fault = "client";
		constructor(opts) {
			super({
				name: "UnauthorizedException",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, UnauthorizedException.prototype);
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sso/schemas/schemas_0.js
var _ATT, _GRC, _GRCR, _GRCRe, _IRE, _RC, _RNFE, _SAKT, _STT, _TMRE, _UE, _aI, _aKI, _aT, _ai, _c, _e, _ex, _h, _hE, _hH, _hQ, _m, _rC, _rN, _rn, _s, _sAK, _sT, _xasbt, n0, _s_registry, SSOServiceException$, n0_registry, InvalidRequestException$, ResourceNotFoundException$, TooManyRequestsException$, UnauthorizedException$, errorTypeRegistries, AccessTokenType, SecretAccessKeyType, SessionTokenType, GetRoleCredentialsRequest$, GetRoleCredentialsResponse$, RoleCredentials$, GetRoleCredentials$;
var init_schemas_0 = __esmMin((() => {
	init_schema();
	init_errors();
	init_SSOServiceException();
	_ATT = "AccessTokenType";
	_GRC = "GetRoleCredentials";
	_GRCR = "GetRoleCredentialsRequest";
	_GRCRe = "GetRoleCredentialsResponse";
	_IRE = "InvalidRequestException";
	_RC = "RoleCredentials";
	_RNFE = "ResourceNotFoundException";
	_SAKT = "SecretAccessKeyType";
	_STT = "SessionTokenType";
	_TMRE = "TooManyRequestsException";
	_UE = "UnauthorizedException";
	_aI = "accountId";
	_aKI = "accessKeyId";
	_aT = "accessToken";
	_ai = "account_id";
	_c = "client";
	_e = "error";
	_ex = "expiration";
	_h = "http";
	_hE = "httpError";
	_hH = "httpHeader";
	_hQ = "httpQuery";
	_m = "message";
	_rC = "roleCredentials";
	_rN = "roleName";
	_rn = "role_name";
	_s = "smithy.ts.sdk.synthetic.com.amazonaws.sso";
	_sAK = "secretAccessKey";
	_sT = "sessionToken";
	_xasbt = "x-amz-sso_bearer_token";
	n0 = "com.amazonaws.sso";
	_s_registry = TypeRegistry.for(_s);
	SSOServiceException$ = [
		-3,
		_s,
		"SSOServiceException",
		0,
		[],
		[]
	];
	_s_registry.registerError(SSOServiceException$, SSOServiceException);
	n0_registry = TypeRegistry.for(n0);
	InvalidRequestException$ = [
		-3,
		n0,
		_IRE,
		{
			[_e]: _c,
			[_hE]: 400
		},
		[_m],
		[0]
	];
	n0_registry.registerError(InvalidRequestException$, InvalidRequestException);
	ResourceNotFoundException$ = [
		-3,
		n0,
		_RNFE,
		{
			[_e]: _c,
			[_hE]: 404
		},
		[_m],
		[0]
	];
	n0_registry.registerError(ResourceNotFoundException$, ResourceNotFoundException);
	TooManyRequestsException$ = [
		-3,
		n0,
		_TMRE,
		{
			[_e]: _c,
			[_hE]: 429
		},
		[_m],
		[0]
	];
	n0_registry.registerError(TooManyRequestsException$, TooManyRequestsException);
	UnauthorizedException$ = [
		-3,
		n0,
		_UE,
		{
			[_e]: _c,
			[_hE]: 401
		},
		[_m],
		[0]
	];
	n0_registry.registerError(UnauthorizedException$, UnauthorizedException);
	errorTypeRegistries = [_s_registry, n0_registry];
	AccessTokenType = [
		0,
		n0,
		_ATT,
		8,
		0
	];
	SecretAccessKeyType = [
		0,
		n0,
		_SAKT,
		8,
		0
	];
	SessionTokenType = [
		0,
		n0,
		_STT,
		8,
		0
	];
	GetRoleCredentialsRequest$ = [
		3,
		n0,
		_GRCR,
		0,
		[
			_rN,
			_aI,
			_aT
		],
		[
			[0, { [_hQ]: _rn }],
			[0, { [_hQ]: _ai }],
			[() => AccessTokenType, { [_hH]: _xasbt }]
		],
		3
	];
	GetRoleCredentialsResponse$ = [
		3,
		n0,
		_GRCRe,
		0,
		[_rC],
		[[() => RoleCredentials$, 0]]
	];
	RoleCredentials$ = [
		3,
		n0,
		_RC,
		0,
		[
			_aKI,
			_sAK,
			_sT,
			_ex
		],
		[
			0,
			[() => SecretAccessKeyType, 0],
			[() => SessionTokenType, 0],
			1
		]
	];
	GetRoleCredentials$ = [
		9,
		n0,
		_GRC,
		{ [_h]: [
			"GET",
			"/federation/credentials",
			200
		] },
		() => GetRoleCredentialsRequest$,
		() => GetRoleCredentialsResponse$
	];
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sso/runtimeConfig.shared.js
var import_dist_cjs$25, import_dist_cjs$26, import_dist_cjs$27, import_dist_cjs$28, getRuntimeConfig$1;
var init_runtimeConfig_shared = __esmMin((() => {
	init_httpAuthSchemes();
	init_protocols();
	init_dist_es();
	import_dist_cjs$25 = require_dist_cjs$25();
	import_dist_cjs$26 = require_dist_cjs$8();
	import_dist_cjs$27 = require_dist_cjs$9();
	import_dist_cjs$28 = require_dist_cjs$10();
	init_httpAuthSchemeProvider();
	init_endpointResolver();
	init_schemas_0();
	getRuntimeConfig$1 = (config) => {
		return {
			apiVersion: "2019-06-10",
			base64Decoder: config?.base64Decoder ?? import_dist_cjs$27.fromBase64,
			base64Encoder: config?.base64Encoder ?? import_dist_cjs$27.toBase64,
			disableHostPrefix: config?.disableHostPrefix ?? false,
			endpointProvider: config?.endpointProvider ?? defaultEndpointResolver,
			extensions: config?.extensions ?? [],
			httpAuthSchemeProvider: config?.httpAuthSchemeProvider ?? defaultSSOHttpAuthSchemeProvider,
			httpAuthSchemes: config?.httpAuthSchemes ?? [{
				schemeId: "aws.auth#sigv4",
				identityProvider: (ipc) => ipc.getIdentityProvider("aws.auth#sigv4"),
				signer: new AwsSdkSigV4Signer()
			}, {
				schemeId: "smithy.api#noAuth",
				identityProvider: (ipc) => ipc.getIdentityProvider("smithy.api#noAuth") || (async () => ({})),
				signer: new NoAuthSigner()
			}],
			logger: config?.logger ?? new import_dist_cjs$25.NoOpLogger(),
			protocol: config?.protocol ?? AwsRestJsonProtocol,
			protocolSettings: config?.protocolSettings ?? {
				defaultNamespace: "com.amazonaws.sso",
				errorTypeRegistries,
				version: "2019-06-10",
				serviceTarget: "SWBPortalService"
			},
			serviceId: config?.serviceId ?? "SSO",
			urlParser: config?.urlParser ?? import_dist_cjs$26.parseUrl,
			utf8Decoder: config?.utf8Decoder ?? import_dist_cjs$28.fromUtf8,
			utf8Encoder: config?.utf8Encoder ?? import_dist_cjs$28.toUtf8
		};
	};
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sso/runtimeConfig.js
var import_dist_cjs$15, import_dist_cjs$16, import_dist_cjs$17, import_dist_cjs$18, import_dist_cjs$19, import_dist_cjs$20, import_dist_cjs$21, import_dist_cjs$22, import_dist_cjs$23, import_dist_cjs$24, getRuntimeConfig;
var init_runtimeConfig = __esmMin((() => {
	init_client();
	init_httpAuthSchemes();
	import_dist_cjs$15 = require_dist_cjs$11();
	import_dist_cjs$16 = require_dist_cjs$12();
	import_dist_cjs$17 = require_dist_cjs$13();
	import_dist_cjs$18 = require_dist_cjs$14();
	import_dist_cjs$19 = require_dist_cjs$15();
	import_dist_cjs$20 = require_dist_cjs$26();
	import_dist_cjs$21 = require_dist_cjs$25();
	import_dist_cjs$22 = require_dist_cjs$16();
	import_dist_cjs$23 = require_dist_cjs$17();
	import_dist_cjs$24 = require_dist_cjs$4();
	init_runtimeConfig_shared();
	getRuntimeConfig = (config) => {
		(0, import_dist_cjs$21.emitWarningIfUnsupportedVersion)(process.version);
		const defaultsMode = (0, import_dist_cjs$23.resolveDefaultsModeConfig)(config);
		const defaultConfigProvider = () => defaultsMode().then(import_dist_cjs$21.loadConfigsForDefaultMode);
		const clientSharedValues = getRuntimeConfig$1(config);
		emitWarningIfUnsupportedVersion$1(process.version);
		const loaderConfig = {
			profile: config?.profile,
			logger: clientSharedValues.logger
		};
		return {
			...clientSharedValues,
			...config,
			runtime: "node",
			defaultsMode,
			authSchemePreference: config?.authSchemePreference ?? (0, import_dist_cjs$19.loadConfig)(NODE_AUTH_SCHEME_PREFERENCE_OPTIONS, loaderConfig),
			bodyLengthChecker: config?.bodyLengthChecker ?? import_dist_cjs$22.calculateBodyLength,
			defaultUserAgentProvider: config?.defaultUserAgentProvider ?? (0, import_dist_cjs$15.createDefaultUserAgentProvider)({
				serviceId: clientSharedValues.serviceId,
				clientVersion: version
			}),
			maxAttempts: config?.maxAttempts ?? (0, import_dist_cjs$19.loadConfig)(import_dist_cjs$18.NODE_MAX_ATTEMPT_CONFIG_OPTIONS, config),
			region: config?.region ?? (0, import_dist_cjs$19.loadConfig)(import_dist_cjs$16.NODE_REGION_CONFIG_OPTIONS, {
				...import_dist_cjs$16.NODE_REGION_CONFIG_FILE_OPTIONS,
				...loaderConfig
			}),
			requestHandler: import_dist_cjs$20.NodeHttpHandler.create(config?.requestHandler ?? defaultConfigProvider),
			retryMode: config?.retryMode ?? (0, import_dist_cjs$19.loadConfig)({
				...import_dist_cjs$18.NODE_RETRY_MODE_CONFIG_OPTIONS,
				default: async () => (await defaultConfigProvider()).retryMode || import_dist_cjs$24.DEFAULT_RETRY_MODE
			}, config),
			sha256: config?.sha256 ?? import_dist_cjs$17.Hash.bind(null, "sha256"),
			streamCollector: config?.streamCollector ?? import_dist_cjs$20.streamCollector,
			useDualstackEndpoint: config?.useDualstackEndpoint ?? (0, import_dist_cjs$19.loadConfig)(import_dist_cjs$16.NODE_USE_DUALSTACK_ENDPOINT_CONFIG_OPTIONS, loaderConfig),
			useFipsEndpoint: config?.useFipsEndpoint ?? (0, import_dist_cjs$19.loadConfig)(import_dist_cjs$16.NODE_USE_FIPS_ENDPOINT_CONFIG_OPTIONS, loaderConfig),
			userAgentAppId: config?.userAgentAppId ?? (0, import_dist_cjs$19.loadConfig)(import_dist_cjs$15.NODE_APP_ID_CONFIG_OPTIONS, loaderConfig)
		};
	};
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sso/auth/httpAuthExtensionConfiguration.js
var getHttpAuthExtensionConfiguration, resolveHttpAuthRuntimeConfig;
var init_httpAuthExtensionConfiguration = __esmMin((() => {
	getHttpAuthExtensionConfiguration = (runtimeConfig) => {
		const _httpAuthSchemes = runtimeConfig.httpAuthSchemes;
		let _httpAuthSchemeProvider = runtimeConfig.httpAuthSchemeProvider;
		let _credentials = runtimeConfig.credentials;
		return {
			setHttpAuthScheme(httpAuthScheme) {
				const index = _httpAuthSchemes.findIndex((scheme) => scheme.schemeId === httpAuthScheme.schemeId);
				if (index === -1) _httpAuthSchemes.push(httpAuthScheme);
				else _httpAuthSchemes.splice(index, 1, httpAuthScheme);
			},
			httpAuthSchemes() {
				return _httpAuthSchemes;
			},
			setHttpAuthSchemeProvider(httpAuthSchemeProvider) {
				_httpAuthSchemeProvider = httpAuthSchemeProvider;
			},
			httpAuthSchemeProvider() {
				return _httpAuthSchemeProvider;
			},
			setCredentials(credentials) {
				_credentials = credentials;
			},
			credentials() {
				return _credentials;
			}
		};
	};
	resolveHttpAuthRuntimeConfig = (config) => {
		return {
			httpAuthSchemes: config.httpAuthSchemes(),
			httpAuthSchemeProvider: config.httpAuthSchemeProvider(),
			credentials: config.credentials()
		};
	};
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sso/runtimeExtensions.js
var import_dist_cjs$12, import_dist_cjs$13, import_dist_cjs$14, resolveRuntimeExtensions;
var init_runtimeExtensions = __esmMin((() => {
	import_dist_cjs$12 = require_dist_cjs$18();
	import_dist_cjs$13 = require_dist_cjs$2();
	import_dist_cjs$14 = require_dist_cjs$25();
	init_httpAuthExtensionConfiguration();
	resolveRuntimeExtensions = (runtimeConfig, extensions) => {
		const extensionConfiguration = Object.assign((0, import_dist_cjs$12.getAwsRegionExtensionConfiguration)(runtimeConfig), (0, import_dist_cjs$14.getDefaultExtensionConfiguration)(runtimeConfig), (0, import_dist_cjs$13.getHttpHandlerExtensionConfiguration)(runtimeConfig), getHttpAuthExtensionConfiguration(runtimeConfig));
		extensions.forEach((extension) => extension.configure(extensionConfiguration));
		return Object.assign(runtimeConfig, (0, import_dist_cjs$12.resolveAwsRegionExtensionConfiguration)(extensionConfiguration), (0, import_dist_cjs$14.resolveDefaultRuntimeConfig)(extensionConfiguration), (0, import_dist_cjs$13.resolveHttpHandlerRuntimeConfig)(extensionConfiguration), resolveHttpAuthRuntimeConfig(extensionConfiguration));
	};
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sso/SSOClient.js
var import_dist_cjs$3, import_dist_cjs$4, import_dist_cjs$5, import_dist_cjs$6, import_dist_cjs$7, import_dist_cjs$8, import_dist_cjs$9, import_dist_cjs$10, import_dist_cjs$11, SSOClient;
var init_SSOClient = __esmMin((() => {
	import_dist_cjs$3 = require_dist_cjs$19();
	import_dist_cjs$4 = require_dist_cjs$20();
	import_dist_cjs$5 = require_dist_cjs$21();
	import_dist_cjs$6 = require_dist_cjs$22();
	import_dist_cjs$7 = require_dist_cjs$12();
	init_dist_es();
	init_schema();
	import_dist_cjs$8 = require_dist_cjs$23();
	import_dist_cjs$9 = require_dist_cjs$24();
	import_dist_cjs$10 = require_dist_cjs$14();
	import_dist_cjs$11 = require_dist_cjs$25();
	init_httpAuthSchemeProvider();
	init_EndpointParameters();
	init_runtimeConfig();
	init_runtimeExtensions();
	SSOClient = class extends import_dist_cjs$11.Client {
		config;
		constructor(...[configuration]) {
			const _config_0 = getRuntimeConfig(configuration || {});
			super(_config_0);
			this.initConfig = _config_0;
			const _config_8 = resolveRuntimeExtensions(resolveHttpAuthSchemeConfig((0, import_dist_cjs$9.resolveEndpointConfig)((0, import_dist_cjs$3.resolveHostHeaderConfig)((0, import_dist_cjs$7.resolveRegionConfig)((0, import_dist_cjs$10.resolveRetryConfig)((0, import_dist_cjs$6.resolveUserAgentConfig)(resolveClientEndpointParameters(_config_0))))))), configuration?.extensions || []);
			this.config = _config_8;
			this.middlewareStack.use(getSchemaSerdePlugin(this.config));
			this.middlewareStack.use((0, import_dist_cjs$6.getUserAgentPlugin)(this.config));
			this.middlewareStack.use((0, import_dist_cjs$10.getRetryPlugin)(this.config));
			this.middlewareStack.use((0, import_dist_cjs$8.getContentLengthPlugin)(this.config));
			this.middlewareStack.use((0, import_dist_cjs$3.getHostHeaderPlugin)(this.config));
			this.middlewareStack.use((0, import_dist_cjs$4.getLoggerPlugin)(this.config));
			this.middlewareStack.use((0, import_dist_cjs$5.getRecursionDetectionPlugin)(this.config));
			this.middlewareStack.use(getHttpAuthSchemeEndpointRuleSetPlugin(this.config, {
				httpAuthSchemeParametersProvider: defaultSSOHttpAuthSchemeParametersProvider,
				identityProviderConfigProvider: async (config) => new DefaultIdentityProviderConfig({ "aws.auth#sigv4": config.credentials })
			}));
			this.middlewareStack.use(getHttpSigningPlugin(this.config));
		}
		destroy() {
			super.destroy();
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sso/commands/GetRoleCredentialsCommand.js
var import_dist_cjs$1, import_dist_cjs$2, GetRoleCredentialsCommand;
var init_GetRoleCredentialsCommand = __esmMin((() => {
	import_dist_cjs$1 = require_dist_cjs$24();
	import_dist_cjs$2 = require_dist_cjs$25();
	init_EndpointParameters();
	init_schemas_0();
	GetRoleCredentialsCommand = class extends import_dist_cjs$2.Command.classBuilder().ep(commonParams).m(function(Command, cs, config, o) {
		return [(0, import_dist_cjs$1.getEndpointPlugin)(config, Command.getEndpointParameterInstructions())];
	}).s("SWBPortalService", "GetRoleCredentials", {}).n("SSOClient", "GetRoleCredentialsCommand").sc(GetRoleCredentials$).build() {};
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sso/SSO.js
var import_dist_cjs, commands, SSO;
var init_SSO = __esmMin((() => {
	import_dist_cjs = require_dist_cjs$25();
	init_GetRoleCredentialsCommand();
	init_SSOClient();
	commands = { GetRoleCredentialsCommand };
	SSO = class extends SSOClient {};
	(0, import_dist_cjs.createAggregatedClient)(commands, SSO);
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sso/commands/index.js
var init_commands = __esmMin((() => {
	init_GetRoleCredentialsCommand();
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sso/models/models_0.js
var init_models_0 = __esmMin((() => {}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sso/index.js
var sso_exports = /* @__PURE__ */ __exportAll({
	$Command: () => import_dist_cjs$2.Command,
	GetRoleCredentials$: () => GetRoleCredentials$,
	GetRoleCredentialsCommand: () => GetRoleCredentialsCommand,
	GetRoleCredentialsRequest$: () => GetRoleCredentialsRequest$,
	GetRoleCredentialsResponse$: () => GetRoleCredentialsResponse$,
	InvalidRequestException: () => InvalidRequestException,
	InvalidRequestException$: () => InvalidRequestException$,
	ResourceNotFoundException: () => ResourceNotFoundException,
	ResourceNotFoundException$: () => ResourceNotFoundException$,
	RoleCredentials$: () => RoleCredentials$,
	SSO: () => SSO,
	SSOClient: () => SSOClient,
	SSOServiceException: () => SSOServiceException,
	SSOServiceException$: () => SSOServiceException$,
	TooManyRequestsException: () => TooManyRequestsException,
	TooManyRequestsException$: () => TooManyRequestsException$,
	UnauthorizedException: () => UnauthorizedException,
	UnauthorizedException$: () => UnauthorizedException$,
	__Client: () => import_dist_cjs$11.Client,
	errorTypeRegistries: () => errorTypeRegistries
});
var init_sso = __esmMin((() => {
	init_SSOClient();
	init_SSO();
	init_commands();
	init_schemas_0();
	init_errors();
	init_models_0();
	init_SSOServiceException();
}));
//#endregion
//#region node_modules/@aws-sdk/credential-provider-sso/dist-cjs/loadSso-BKDNrsal.js
var require_loadSso_BKDNrsal = /* @__PURE__ */ __commonJSMin(((exports) => {
	var sso = (init_sso(), __toCommonJS(sso_exports));
	exports.GetRoleCredentialsCommand = sso.GetRoleCredentialsCommand;
	exports.SSOClient = sso.SSOClient;
}));
//#endregion
//#region node_modules/@aws-sdk/credential-provider-sso/dist-cjs/index.js
var require_dist_cjs = /* @__PURE__ */ __commonJSMin(((exports) => {
	var propertyProvider = require_dist_cjs$3();
	var sharedIniFileLoader = require_dist_cjs$27();
	var client = (init_client(), __toCommonJS(client_exports));
	var tokenProviders = require_dist_cjs$1();
	const isSsoProfile = (arg) => arg && (typeof arg.sso_start_url === "string" || typeof arg.sso_account_id === "string" || typeof arg.sso_session === "string" || typeof arg.sso_region === "string" || typeof arg.sso_role_name === "string");
	const SHOULD_FAIL_CREDENTIAL_CHAIN = false;
	const resolveSSOCredentials = async ({ ssoStartUrl, ssoSession, ssoAccountId, ssoRegion, ssoRoleName, ssoClient, clientConfig, parentClientConfig, callerClientConfig, profile, filepath, configFilepath, ignoreCache, logger }) => {
		let token;
		const refreshMessage = `To refresh this SSO session run aws sso login with the corresponding profile.`;
		if (ssoSession) try {
			const _token = await tokenProviders.fromSso({
				profile,
				filepath,
				configFilepath,
				ignoreCache
			})();
			token = {
				accessToken: _token.token,
				expiresAt: new Date(_token.expiration).toISOString()
			};
		} catch (e) {
			throw new propertyProvider.CredentialsProviderError(e.message, {
				tryNextLink: SHOULD_FAIL_CREDENTIAL_CHAIN,
				logger
			});
		}
		else try {
			token = await sharedIniFileLoader.getSSOTokenFromFile(ssoStartUrl);
		} catch (e) {
			throw new propertyProvider.CredentialsProviderError(`The SSO session associated with this profile is invalid. ${refreshMessage}`, {
				tryNextLink: SHOULD_FAIL_CREDENTIAL_CHAIN,
				logger
			});
		}
		if (new Date(token.expiresAt).getTime() - Date.now() <= 0) throw new propertyProvider.CredentialsProviderError(`The SSO session associated with this profile has expired. ${refreshMessage}`, {
			tryNextLink: SHOULD_FAIL_CREDENTIAL_CHAIN,
			logger
		});
		const { accessToken } = token;
		const { SSOClient, GetRoleCredentialsCommand } = await Promise.resolve().then(function() {
			return require_loadSso_BKDNrsal();
		});
		const sso = ssoClient || new SSOClient(Object.assign({}, clientConfig ?? {}, {
			logger: clientConfig?.logger ?? callerClientConfig?.logger ?? parentClientConfig?.logger,
			region: clientConfig?.region ?? ssoRegion,
			userAgentAppId: clientConfig?.userAgentAppId ?? callerClientConfig?.userAgentAppId ?? parentClientConfig?.userAgentAppId
		}));
		let ssoResp;
		try {
			ssoResp = await sso.send(new GetRoleCredentialsCommand({
				accountId: ssoAccountId,
				roleName: ssoRoleName,
				accessToken
			}));
		} catch (e) {
			throw new propertyProvider.CredentialsProviderError(e, {
				tryNextLink: SHOULD_FAIL_CREDENTIAL_CHAIN,
				logger
			});
		}
		const { roleCredentials: { accessKeyId, secretAccessKey, sessionToken, expiration, credentialScope, accountId } = {} } = ssoResp;
		if (!accessKeyId || !secretAccessKey || !sessionToken || !expiration) throw new propertyProvider.CredentialsProviderError("SSO returns an invalid temporary credential.", {
			tryNextLink: SHOULD_FAIL_CREDENTIAL_CHAIN,
			logger
		});
		const credentials = {
			accessKeyId,
			secretAccessKey,
			sessionToken,
			expiration: new Date(expiration),
			...credentialScope && { credentialScope },
			...accountId && { accountId }
		};
		if (ssoSession) client.setCredentialFeature(credentials, "CREDENTIALS_SSO", "s");
		else client.setCredentialFeature(credentials, "CREDENTIALS_SSO_LEGACY", "u");
		return credentials;
	};
	const validateSsoProfile = (profile, logger) => {
		const { sso_start_url, sso_account_id, sso_region, sso_role_name } = profile;
		if (!sso_start_url || !sso_account_id || !sso_region || !sso_role_name) throw new propertyProvider.CredentialsProviderError(`Profile is configured with invalid SSO credentials. Required parameters "sso_account_id", "sso_region", "sso_role_name", "sso_start_url". Got ${Object.keys(profile).join(", ")}\nReference: https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html`, {
			tryNextLink: false,
			logger
		});
		return profile;
	};
	const fromSSO = (init = {}) => async ({ callerClientConfig } = {}) => {
		init.logger?.debug("@aws-sdk/credential-provider-sso - fromSSO");
		const { ssoStartUrl, ssoAccountId, ssoRegion, ssoRoleName, ssoSession } = init;
		const { ssoClient } = init;
		const profileName = sharedIniFileLoader.getProfileName({ profile: init.profile ?? callerClientConfig?.profile });
		if (!ssoStartUrl && !ssoAccountId && !ssoRegion && !ssoRoleName && !ssoSession) {
			const profile = (await sharedIniFileLoader.parseKnownFiles(init))[profileName];
			if (!profile) throw new propertyProvider.CredentialsProviderError(`Profile ${profileName} was not found.`, { logger: init.logger });
			if (!isSsoProfile(profile)) throw new propertyProvider.CredentialsProviderError(`Profile ${profileName} is not configured with SSO credentials.`, { logger: init.logger });
			if (profile?.sso_session) {
				const session = (await sharedIniFileLoader.loadSsoSessionData(init))[profile.sso_session];
				const conflictMsg = ` configurations in profile ${profileName} and sso-session ${profile.sso_session}`;
				if (ssoRegion && ssoRegion !== session.sso_region) throw new propertyProvider.CredentialsProviderError(`Conflicting SSO region` + conflictMsg, {
					tryNextLink: false,
					logger: init.logger
				});
				if (ssoStartUrl && ssoStartUrl !== session.sso_start_url) throw new propertyProvider.CredentialsProviderError(`Conflicting SSO start_url` + conflictMsg, {
					tryNextLink: false,
					logger: init.logger
				});
				profile.sso_region = session.sso_region;
				profile.sso_start_url = session.sso_start_url;
			}
			const { sso_start_url, sso_account_id, sso_region, sso_role_name, sso_session } = validateSsoProfile(profile, init.logger);
			return resolveSSOCredentials({
				ssoStartUrl: sso_start_url,
				ssoSession: sso_session,
				ssoAccountId: sso_account_id,
				ssoRegion: sso_region,
				ssoRoleName: sso_role_name,
				ssoClient,
				clientConfig: init.clientConfig,
				parentClientConfig: init.parentClientConfig,
				callerClientConfig: init.callerClientConfig,
				profile: profileName,
				filepath: init.filepath,
				configFilepath: init.configFilepath,
				ignoreCache: init.ignoreCache,
				logger: init.logger
			});
		} else if (!ssoStartUrl || !ssoAccountId || !ssoRegion || !ssoRoleName) throw new propertyProvider.CredentialsProviderError("Incomplete configuration. The fromSSO() argument hash must include \"ssoStartUrl\", \"ssoAccountId\", \"ssoRegion\", \"ssoRoleName\"", {
			tryNextLink: false,
			logger: init.logger
		});
		else return resolveSSOCredentials({
			ssoStartUrl,
			ssoSession,
			ssoAccountId,
			ssoRegion,
			ssoRoleName,
			ssoClient,
			clientConfig: init.clientConfig,
			parentClientConfig: init.parentClientConfig,
			callerClientConfig: init.callerClientConfig,
			profile: profileName,
			filepath: init.filepath,
			configFilepath: init.configFilepath,
			ignoreCache: init.ignoreCache,
			logger: init.logger
		});
	};
	exports.fromSSO = fromSSO;
	exports.isSsoProfile = isSsoProfile;
	exports.validateSsoProfile = validateSsoProfile;
}));
//#endregion
export default require_dist_cjs();
export {};
