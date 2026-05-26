import { n as __esmMin } from "./chunk-HkwdBwDg.js";
import { A as getSchemaSerdePlugin, E as init_schema, O as TypeRegistry } from "./protocols-CO3NMy6S.js";
import { t as require_dist_cjs } from "./dist-cjs-DQR3Meck.js";
import { c as emitWarningIfUnsupportedVersion$1, i as require_dist_cjs$1, r as init_client } from "./dist-cjs-DS9W42km.js";
import { B as require_dist_cjs$7, D as getHttpSigningPlugin, E as DefaultIdentityProviderConfig, F as require_dist_cjs$6, I as require_dist_cjs$18, L as require_dist_cjs$17, O as getHttpAuthSchemeEndpointRuleSetPlugin, P as AwsRestJsonProtocol, R as require_dist_cjs$16, S as require_dist_cjs$3, T as NoAuthSigner, _ as require_dist_cjs$20, a as require_dist_cjs$10, b as require_dist_cjs$4, c as init_httpAuthSchemes, f as NODE_AUTH_SCHEME_PREFERENCE_OPTIONS, g as require_dist_cjs$21, h as require_dist_cjs$11, i as require_dist_cjs$12, j as init_protocols, l as resolveAwsSdkSigV4Config, m as AwsSdkSigV4Signer, n as require_dist_cjs$14, o as require_dist_cjs$8, r as require_dist_cjs$13, t as require_dist_cjs$15, v as require_dist_cjs$9, w as init_dist_es, x as require_dist_cjs$5, y as require_dist_cjs$19, z as require_dist_cjs$2 } from "./dist-cjs-D0pP6SUX.js";
import { n as require_dist_cjs$22, t as require_dist_cjs$23 } from "./dist-cjs-DDGLQYvl.js";
import { t as version } from "./package-CNqrm-wp.js";
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sso-oidc/auth/httpAuthSchemeProvider.js
function createAwsAuthSigv4HttpAuthOption(authParameters) {
	return {
		schemeId: "aws.auth#sigv4",
		signingProperties: {
			name: "sso-oauth",
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
var import_dist_cjs$33, defaultSSOOIDCHttpAuthSchemeParametersProvider, defaultSSOOIDCHttpAuthSchemeProvider, resolveHttpAuthSchemeConfig;
var init_httpAuthSchemeProvider = __esmMin((() => {
	init_httpAuthSchemes();
	import_dist_cjs$33 = require_dist_cjs$2();
	defaultSSOOIDCHttpAuthSchemeParametersProvider = async (config, context, input) => {
		return {
			operation: (0, import_dist_cjs$33.getSmithyContext)(context).operation,
			region: await (0, import_dist_cjs$33.normalizeProvider)(config.region)() || (() => {
				throw new Error("expected `region` to be configured for `aws.auth#sigv4`");
			})()
		};
	};
	defaultSSOOIDCHttpAuthSchemeProvider = (authParameters) => {
		const options = [];
		switch (authParameters.operation) {
			case "CreateToken":
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
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sso-oidc/endpoint/EndpointParameters.js
var resolveClientEndpointParameters, commonParams;
var init_EndpointParameters = __esmMin((() => {
	resolveClientEndpointParameters = (options) => {
		return Object.assign(options, {
			useDualstackEndpoint: options.useDualstackEndpoint ?? false,
			useFipsEndpoint: options.useFipsEndpoint ?? false,
			defaultSigningName: "sso-oauth"
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
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sso-oidc/endpoint/bdd.js
var import_dist_cjs$32, k, a, b, c, d, e, f, g, h, i, j, _data, root, r, nodes, bdd;
var init_bdd = __esmMin((() => {
	import_dist_cjs$32 = require_dist_cjs$3();
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
			["https://oidc-fips.{Region}.{PartitionResult#dualStackDnsSuffix}", i],
			[a, "FIPS and DualStack are enabled, but this partition does not support one or both"],
			["https://oidc.{Region}.amazonaws.com", i],
			["https://oidc-fips.{Region}.{PartitionResult#dnsSuffix}", i],
			[a, "FIPS is enabled but this partition does not support FIPS"],
			["https://oidc.{Region}.{PartitionResult#dualStackDnsSuffix}", i],
			[a, "DualStack is enabled but this partition does not support DualStack"],
			["https://oidc.{Region}.{PartitionResult#dnsSuffix}", i],
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
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sso-oidc/endpoint/endpointResolver.js
var import_dist_cjs$30, import_dist_cjs$31, cache, defaultEndpointResolver;
var init_endpointResolver = __esmMin((() => {
	import_dist_cjs$30 = require_dist_cjs$4();
	import_dist_cjs$31 = require_dist_cjs$3();
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
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sso-oidc/models/SSOOIDCServiceException.js
var import_dist_cjs$29, SSOOIDCServiceException;
var init_SSOOIDCServiceException = __esmMin((() => {
	import_dist_cjs$29 = require_dist_cjs$22();
	SSOOIDCServiceException = class SSOOIDCServiceException extends import_dist_cjs$29.ServiceException {
		constructor(options) {
			super(options);
			Object.setPrototypeOf(this, SSOOIDCServiceException.prototype);
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sso-oidc/models/errors.js
var AccessDeniedException, AuthorizationPendingException, ExpiredTokenException, InternalServerException, InvalidClientException, InvalidGrantException, InvalidRequestException, InvalidScopeException, SlowDownException, UnauthorizedClientException, UnsupportedGrantTypeException;
var init_errors = __esmMin((() => {
	init_SSOOIDCServiceException();
	AccessDeniedException = class AccessDeniedException extends SSOOIDCServiceException {
		name = "AccessDeniedException";
		$fault = "client";
		error;
		reason;
		error_description;
		constructor(opts) {
			super({
				name: "AccessDeniedException",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, AccessDeniedException.prototype);
			this.error = opts.error;
			this.reason = opts.reason;
			this.error_description = opts.error_description;
		}
	};
	AuthorizationPendingException = class AuthorizationPendingException extends SSOOIDCServiceException {
		name = "AuthorizationPendingException";
		$fault = "client";
		error;
		error_description;
		constructor(opts) {
			super({
				name: "AuthorizationPendingException",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, AuthorizationPendingException.prototype);
			this.error = opts.error;
			this.error_description = opts.error_description;
		}
	};
	ExpiredTokenException = class ExpiredTokenException extends SSOOIDCServiceException {
		name = "ExpiredTokenException";
		$fault = "client";
		error;
		error_description;
		constructor(opts) {
			super({
				name: "ExpiredTokenException",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, ExpiredTokenException.prototype);
			this.error = opts.error;
			this.error_description = opts.error_description;
		}
	};
	InternalServerException = class InternalServerException extends SSOOIDCServiceException {
		name = "InternalServerException";
		$fault = "server";
		error;
		error_description;
		constructor(opts) {
			super({
				name: "InternalServerException",
				$fault: "server",
				...opts
			});
			Object.setPrototypeOf(this, InternalServerException.prototype);
			this.error = opts.error;
			this.error_description = opts.error_description;
		}
	};
	InvalidClientException = class InvalidClientException extends SSOOIDCServiceException {
		name = "InvalidClientException";
		$fault = "client";
		error;
		error_description;
		constructor(opts) {
			super({
				name: "InvalidClientException",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, InvalidClientException.prototype);
			this.error = opts.error;
			this.error_description = opts.error_description;
		}
	};
	InvalidGrantException = class InvalidGrantException extends SSOOIDCServiceException {
		name = "InvalidGrantException";
		$fault = "client";
		error;
		error_description;
		constructor(opts) {
			super({
				name: "InvalidGrantException",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, InvalidGrantException.prototype);
			this.error = opts.error;
			this.error_description = opts.error_description;
		}
	};
	InvalidRequestException = class InvalidRequestException extends SSOOIDCServiceException {
		name = "InvalidRequestException";
		$fault = "client";
		error;
		reason;
		error_description;
		constructor(opts) {
			super({
				name: "InvalidRequestException",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, InvalidRequestException.prototype);
			this.error = opts.error;
			this.reason = opts.reason;
			this.error_description = opts.error_description;
		}
	};
	InvalidScopeException = class InvalidScopeException extends SSOOIDCServiceException {
		name = "InvalidScopeException";
		$fault = "client";
		error;
		error_description;
		constructor(opts) {
			super({
				name: "InvalidScopeException",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, InvalidScopeException.prototype);
			this.error = opts.error;
			this.error_description = opts.error_description;
		}
	};
	SlowDownException = class SlowDownException extends SSOOIDCServiceException {
		name = "SlowDownException";
		$fault = "client";
		error;
		error_description;
		constructor(opts) {
			super({
				name: "SlowDownException",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, SlowDownException.prototype);
			this.error = opts.error;
			this.error_description = opts.error_description;
		}
	};
	UnauthorizedClientException = class UnauthorizedClientException extends SSOOIDCServiceException {
		name = "UnauthorizedClientException";
		$fault = "client";
		error;
		error_description;
		constructor(opts) {
			super({
				name: "UnauthorizedClientException",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, UnauthorizedClientException.prototype);
			this.error = opts.error;
			this.error_description = opts.error_description;
		}
	};
	UnsupportedGrantTypeException = class UnsupportedGrantTypeException extends SSOOIDCServiceException {
		name = "UnsupportedGrantTypeException";
		$fault = "client";
		error;
		error_description;
		constructor(opts) {
			super({
				name: "UnsupportedGrantTypeException",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, UnsupportedGrantTypeException.prototype);
			this.error = opts.error;
			this.error_description = opts.error_description;
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sso-oidc/schemas/schemas_0.js
var _ADE, _APE, _AT, _CS, _CT, _CTR, _CTRr, _CV, _ETE, _ICE, _IGE, _IRE, _ISE, _ISEn, _IT, _RT, _SDE, _UCE, _UGTE, _aT, _c, _cI, _cS, _cV, _co, _dC, _e, _eI, _ed, _gT, _h, _hE, _iT, _r, _rT, _rU, _s, _sc, _se, _tT, n0, _s_registry, SSOOIDCServiceException$, n0_registry, AccessDeniedException$, AuthorizationPendingException$, ExpiredTokenException$, InternalServerException$, InvalidClientException$, InvalidGrantException$, InvalidRequestException$, InvalidScopeException$, SlowDownException$, UnauthorizedClientException$, UnsupportedGrantTypeException$, errorTypeRegistries, AccessToken, ClientSecret, CodeVerifier, IdToken, RefreshToken, CreateTokenRequest$, CreateTokenResponse$, CreateToken$;
var init_schemas_0 = __esmMin((() => {
	init_schema();
	init_errors();
	init_SSOOIDCServiceException();
	_ADE = "AccessDeniedException";
	_APE = "AuthorizationPendingException";
	_AT = "AccessToken";
	_CS = "ClientSecret";
	_CT = "CreateToken";
	_CTR = "CreateTokenRequest";
	_CTRr = "CreateTokenResponse";
	_CV = "CodeVerifier";
	_ETE = "ExpiredTokenException";
	_ICE = "InvalidClientException";
	_IGE = "InvalidGrantException";
	_IRE = "InvalidRequestException";
	_ISE = "InternalServerException";
	_ISEn = "InvalidScopeException";
	_IT = "IdToken";
	_RT = "RefreshToken";
	_SDE = "SlowDownException";
	_UCE = "UnauthorizedClientException";
	_UGTE = "UnsupportedGrantTypeException";
	_aT = "accessToken";
	_c = "client";
	_cI = "clientId";
	_cS = "clientSecret";
	_cV = "codeVerifier";
	_co = "code";
	_dC = "deviceCode";
	_e = "error";
	_eI = "expiresIn";
	_ed = "error_description";
	_gT = "grantType";
	_h = "http";
	_hE = "httpError";
	_iT = "idToken";
	_r = "reason";
	_rT = "refreshToken";
	_rU = "redirectUri";
	_s = "smithy.ts.sdk.synthetic.com.amazonaws.ssooidc";
	_sc = "scope";
	_se = "server";
	_tT = "tokenType";
	n0 = "com.amazonaws.ssooidc";
	_s_registry = TypeRegistry.for(_s);
	SSOOIDCServiceException$ = [
		-3,
		_s,
		"SSOOIDCServiceException",
		0,
		[],
		[]
	];
	_s_registry.registerError(SSOOIDCServiceException$, SSOOIDCServiceException);
	n0_registry = TypeRegistry.for(n0);
	AccessDeniedException$ = [
		-3,
		n0,
		_ADE,
		{
			[_e]: _c,
			[_hE]: 400
		},
		[
			_e,
			_r,
			_ed
		],
		[
			0,
			0,
			0
		]
	];
	n0_registry.registerError(AccessDeniedException$, AccessDeniedException);
	AuthorizationPendingException$ = [
		-3,
		n0,
		_APE,
		{
			[_e]: _c,
			[_hE]: 400
		},
		[_e, _ed],
		[0, 0]
	];
	n0_registry.registerError(AuthorizationPendingException$, AuthorizationPendingException);
	ExpiredTokenException$ = [
		-3,
		n0,
		_ETE,
		{
			[_e]: _c,
			[_hE]: 400
		},
		[_e, _ed],
		[0, 0]
	];
	n0_registry.registerError(ExpiredTokenException$, ExpiredTokenException);
	InternalServerException$ = [
		-3,
		n0,
		_ISE,
		{
			[_e]: _se,
			[_hE]: 500
		},
		[_e, _ed],
		[0, 0]
	];
	n0_registry.registerError(InternalServerException$, InternalServerException);
	InvalidClientException$ = [
		-3,
		n0,
		_ICE,
		{
			[_e]: _c,
			[_hE]: 401
		},
		[_e, _ed],
		[0, 0]
	];
	n0_registry.registerError(InvalidClientException$, InvalidClientException);
	InvalidGrantException$ = [
		-3,
		n0,
		_IGE,
		{
			[_e]: _c,
			[_hE]: 400
		},
		[_e, _ed],
		[0, 0]
	];
	n0_registry.registerError(InvalidGrantException$, InvalidGrantException);
	InvalidRequestException$ = [
		-3,
		n0,
		_IRE,
		{
			[_e]: _c,
			[_hE]: 400
		},
		[
			_e,
			_r,
			_ed
		],
		[
			0,
			0,
			0
		]
	];
	n0_registry.registerError(InvalidRequestException$, InvalidRequestException);
	InvalidScopeException$ = [
		-3,
		n0,
		_ISEn,
		{
			[_e]: _c,
			[_hE]: 400
		},
		[_e, _ed],
		[0, 0]
	];
	n0_registry.registerError(InvalidScopeException$, InvalidScopeException);
	SlowDownException$ = [
		-3,
		n0,
		_SDE,
		{
			[_e]: _c,
			[_hE]: 400
		},
		[_e, _ed],
		[0, 0]
	];
	n0_registry.registerError(SlowDownException$, SlowDownException);
	UnauthorizedClientException$ = [
		-3,
		n0,
		_UCE,
		{
			[_e]: _c,
			[_hE]: 400
		},
		[_e, _ed],
		[0, 0]
	];
	n0_registry.registerError(UnauthorizedClientException$, UnauthorizedClientException);
	UnsupportedGrantTypeException$ = [
		-3,
		n0,
		_UGTE,
		{
			[_e]: _c,
			[_hE]: 400
		},
		[_e, _ed],
		[0, 0]
	];
	n0_registry.registerError(UnsupportedGrantTypeException$, UnsupportedGrantTypeException);
	errorTypeRegistries = [_s_registry, n0_registry];
	AccessToken = [
		0,
		n0,
		_AT,
		8,
		0
	];
	ClientSecret = [
		0,
		n0,
		_CS,
		8,
		0
	];
	CodeVerifier = [
		0,
		n0,
		_CV,
		8,
		0
	];
	IdToken = [
		0,
		n0,
		_IT,
		8,
		0
	];
	RefreshToken = [
		0,
		n0,
		_RT,
		8,
		0
	];
	CreateTokenRequest$ = [
		3,
		n0,
		_CTR,
		0,
		[
			_cI,
			_cS,
			_gT,
			_dC,
			_co,
			_rT,
			_sc,
			_rU,
			_cV
		],
		[
			0,
			[() => ClientSecret, 0],
			0,
			0,
			0,
			[() => RefreshToken, 0],
			64,
			0,
			[() => CodeVerifier, 0]
		],
		3
	];
	CreateTokenResponse$ = [
		3,
		n0,
		_CTRr,
		0,
		[
			_aT,
			_tT,
			_eI,
			_rT,
			_iT
		],
		[
			[() => AccessToken, 0],
			0,
			1,
			[() => RefreshToken, 0],
			[() => IdToken, 0]
		]
	];
	CreateToken$ = [
		9,
		n0,
		_CT,
		{ [_h]: [
			"POST",
			"/token",
			200
		] },
		() => CreateTokenRequest$,
		() => CreateTokenResponse$
	];
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sso-oidc/runtimeConfig.shared.js
var import_dist_cjs$25, import_dist_cjs$26, import_dist_cjs$27, import_dist_cjs$28, getRuntimeConfig$1;
var init_runtimeConfig_shared = __esmMin((() => {
	init_httpAuthSchemes();
	init_protocols();
	init_dist_es();
	import_dist_cjs$25 = require_dist_cjs$22();
	import_dist_cjs$26 = require_dist_cjs$5();
	import_dist_cjs$27 = require_dist_cjs$6();
	import_dist_cjs$28 = require_dist_cjs$7();
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
			httpAuthSchemeProvider: config?.httpAuthSchemeProvider ?? defaultSSOOIDCHttpAuthSchemeProvider,
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
				defaultNamespace: "com.amazonaws.ssooidc",
				errorTypeRegistries,
				version: "2019-06-10",
				serviceTarget: "AWSSSOOIDCService"
			},
			serviceId: config?.serviceId ?? "SSO OIDC",
			urlParser: config?.urlParser ?? import_dist_cjs$26.parseUrl,
			utf8Decoder: config?.utf8Decoder ?? import_dist_cjs$28.fromUtf8,
			utf8Encoder: config?.utf8Encoder ?? import_dist_cjs$28.toUtf8
		};
	};
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sso-oidc/runtimeConfig.js
var import_dist_cjs$15, import_dist_cjs$16, import_dist_cjs$17, import_dist_cjs$18, import_dist_cjs$19, import_dist_cjs$20, import_dist_cjs$21, import_dist_cjs$22, import_dist_cjs$23, import_dist_cjs$24, getRuntimeConfig;
var init_runtimeConfig = __esmMin((() => {
	init_client();
	init_httpAuthSchemes();
	import_dist_cjs$15 = require_dist_cjs$8();
	import_dist_cjs$16 = require_dist_cjs$9();
	import_dist_cjs$17 = require_dist_cjs$10();
	import_dist_cjs$18 = require_dist_cjs$11();
	import_dist_cjs$19 = require_dist_cjs$12();
	import_dist_cjs$20 = require_dist_cjs$23();
	import_dist_cjs$21 = require_dist_cjs$22();
	import_dist_cjs$22 = require_dist_cjs$13();
	import_dist_cjs$23 = require_dist_cjs$14();
	import_dist_cjs$24 = require_dist_cjs$1();
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
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sso-oidc/auth/httpAuthExtensionConfiguration.js
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
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sso-oidc/runtimeExtensions.js
var import_dist_cjs$12, import_dist_cjs$13, import_dist_cjs$14, resolveRuntimeExtensions;
var init_runtimeExtensions = __esmMin((() => {
	import_dist_cjs$12 = require_dist_cjs$15();
	import_dist_cjs$13 = require_dist_cjs();
	import_dist_cjs$14 = require_dist_cjs$22();
	init_httpAuthExtensionConfiguration();
	resolveRuntimeExtensions = (runtimeConfig, extensions) => {
		const extensionConfiguration = Object.assign((0, import_dist_cjs$12.getAwsRegionExtensionConfiguration)(runtimeConfig), (0, import_dist_cjs$14.getDefaultExtensionConfiguration)(runtimeConfig), (0, import_dist_cjs$13.getHttpHandlerExtensionConfiguration)(runtimeConfig), getHttpAuthExtensionConfiguration(runtimeConfig));
		extensions.forEach((extension) => extension.configure(extensionConfiguration));
		return Object.assign(runtimeConfig, (0, import_dist_cjs$12.resolveAwsRegionExtensionConfiguration)(extensionConfiguration), (0, import_dist_cjs$14.resolveDefaultRuntimeConfig)(extensionConfiguration), (0, import_dist_cjs$13.resolveHttpHandlerRuntimeConfig)(extensionConfiguration), resolveHttpAuthRuntimeConfig(extensionConfiguration));
	};
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sso-oidc/SSOOIDCClient.js
var import_dist_cjs$3, import_dist_cjs$4, import_dist_cjs$5, import_dist_cjs$6, import_dist_cjs$7, import_dist_cjs$8, import_dist_cjs$9, import_dist_cjs$10, import_dist_cjs$11, SSOOIDCClient;
var init_SSOOIDCClient = __esmMin((() => {
	import_dist_cjs$3 = require_dist_cjs$16();
	import_dist_cjs$4 = require_dist_cjs$17();
	import_dist_cjs$5 = require_dist_cjs$18();
	import_dist_cjs$6 = require_dist_cjs$19();
	import_dist_cjs$7 = require_dist_cjs$9();
	init_dist_es();
	init_schema();
	import_dist_cjs$8 = require_dist_cjs$20();
	import_dist_cjs$9 = require_dist_cjs$21();
	import_dist_cjs$10 = require_dist_cjs$11();
	import_dist_cjs$11 = require_dist_cjs$22();
	init_httpAuthSchemeProvider();
	init_EndpointParameters();
	init_runtimeConfig();
	init_runtimeExtensions();
	SSOOIDCClient = class extends import_dist_cjs$11.Client {
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
				httpAuthSchemeParametersProvider: defaultSSOOIDCHttpAuthSchemeParametersProvider,
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
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sso-oidc/commands/CreateTokenCommand.js
var import_dist_cjs$1, import_dist_cjs$2, CreateTokenCommand;
var init_CreateTokenCommand = __esmMin((() => {
	import_dist_cjs$1 = require_dist_cjs$21();
	import_dist_cjs$2 = require_dist_cjs$22();
	init_EndpointParameters();
	init_schemas_0();
	CreateTokenCommand = class extends import_dist_cjs$2.Command.classBuilder().ep(commonParams).m(function(Command, cs, config, o) {
		return [(0, import_dist_cjs$1.getEndpointPlugin)(config, Command.getEndpointParameterInstructions())];
	}).s("AWSSSOOIDCService", "CreateToken", {}).n("SSOOIDCClient", "CreateTokenCommand").sc(CreateToken$).build() {};
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sso-oidc/SSOOIDC.js
var import_dist_cjs, commands, SSOOIDC;
var init_SSOOIDC = __esmMin((() => {
	import_dist_cjs = require_dist_cjs$22();
	init_CreateTokenCommand();
	init_SSOOIDCClient();
	commands = { CreateTokenCommand };
	SSOOIDC = class extends SSOOIDCClient {};
	(0, import_dist_cjs.createAggregatedClient)(commands, SSOOIDC);
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sso-oidc/commands/index.js
var init_commands = __esmMin((() => {
	init_CreateTokenCommand();
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sso-oidc/models/enums.js
var init_enums = __esmMin((() => {}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sso-oidc/models/models_0.js
var init_models_0 = __esmMin((() => {}));
//#endregion
__esmMin((() => {
	init_SSOOIDCClient();
	init_SSOOIDC();
	init_commands();
	init_schemas_0();
	init_enums();
	init_errors();
	init_models_0();
	init_SSOOIDCServiceException();
}))();
export { CreateTokenCommand, SSOOIDCClient };
