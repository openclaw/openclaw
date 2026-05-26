import { n as __esmMin } from "./chunk-HkwdBwDg.js";
import { A as getSchemaSerdePlugin, E as init_schema, O as TypeRegistry } from "./protocols-CO3NMy6S.js";
import { t as require_dist_cjs } from "./dist-cjs-DQR3Meck.js";
import { c as emitWarningIfUnsupportedVersion$1, i as require_dist_cjs$1, r as init_client } from "./dist-cjs-DS9W42km.js";
import { B as require_dist_cjs$7, D as getHttpSigningPlugin, E as DefaultIdentityProviderConfig, F as require_dist_cjs$6, I as require_dist_cjs$18, L as require_dist_cjs$17, O as getHttpAuthSchemeEndpointRuleSetPlugin, P as AwsRestJsonProtocol, R as require_dist_cjs$16, S as require_dist_cjs$3, T as NoAuthSigner, _ as require_dist_cjs$20, a as require_dist_cjs$10, b as require_dist_cjs$4, c as init_httpAuthSchemes, f as NODE_AUTH_SCHEME_PREFERENCE_OPTIONS, g as require_dist_cjs$21, h as require_dist_cjs$11, i as require_dist_cjs$12, j as init_protocols, l as resolveAwsSdkSigV4Config, m as AwsSdkSigV4Signer, n as require_dist_cjs$14, o as require_dist_cjs$8, r as require_dist_cjs$13, t as require_dist_cjs$15, v as require_dist_cjs$9, w as init_dist_es, x as require_dist_cjs$5, y as require_dist_cjs$19, z as require_dist_cjs$2 } from "./dist-cjs-D0pP6SUX.js";
import { n as require_dist_cjs$22, t as require_dist_cjs$23 } from "./dist-cjs-DDGLQYvl.js";
import { t as version } from "./package-CNqrm-wp.js";
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/signin/auth/httpAuthSchemeProvider.js
function createAwsAuthSigv4HttpAuthOption(authParameters) {
	return {
		schemeId: "aws.auth#sigv4",
		signingProperties: {
			name: "signin",
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
var import_dist_cjs$33, defaultSigninHttpAuthSchemeParametersProvider, defaultSigninHttpAuthSchemeProvider, resolveHttpAuthSchemeConfig;
var init_httpAuthSchemeProvider = __esmMin((() => {
	init_httpAuthSchemes();
	import_dist_cjs$33 = require_dist_cjs$2();
	defaultSigninHttpAuthSchemeParametersProvider = async (config, context, input) => {
		return {
			operation: (0, import_dist_cjs$33.getSmithyContext)(context).operation,
			region: await (0, import_dist_cjs$33.normalizeProvider)(config.region)() || (() => {
				throw new Error("expected `region` to be configured for `aws.auth#sigv4`");
			})()
		};
	};
	defaultSigninHttpAuthSchemeProvider = (authParameters) => {
		const options = [];
		switch (authParameters.operation) {
			case "CreateOAuth2Token":
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
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/signin/endpoint/EndpointParameters.js
var resolveClientEndpointParameters, commonParams;
var init_EndpointParameters = __esmMin((() => {
	resolveClientEndpointParameters = (options) => {
		return Object.assign(options, {
			useDualstackEndpoint: options.useDualstackEndpoint ?? false,
			useFipsEndpoint: options.useFipsEndpoint ?? false,
			defaultSigningName: "signin"
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
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/signin/endpoint/bdd.js
var import_dist_cjs$32, m, a, b, c, d, e, f, g, h, i, j, k, l, _data, root, r, nodes, bdd;
var init_bdd = __esmMin((() => {
	import_dist_cjs$32 = require_dist_cjs$3();
	m = "ref";
	a = -1, b = true, c = "isSet", d = "PartitionResult", e = "booleanEquals", f = "getAttr", g = "stringEquals", h = { [m]: "Endpoint" }, i = { [m]: d }, j = {
		fn: f,
		argv: [i, "name"]
	}, k = {}, l = [{ [m]: "Region" }];
	_data = {
		conditions: [
			[c, [h]],
			[c, l],
			[
				"aws.partition",
				l,
				d
			],
			[e, [{ [m]: "UseFIPS" }, b]],
			[e, [{ [m]: "UseDualStack" }, b]],
			[e, [{
				fn: f,
				argv: [i, "supportsDualStack"]
			}, b]],
			[e, [{
				fn: f,
				argv: [i, "supportsFIPS"]
			}, b]],
			[g, [j, "aws"]],
			[g, [j, "aws-cn"]],
			[g, [j, "aws-us-gov"]]
		],
		results: [
			[a],
			[a, "Invalid Configuration: FIPS and custom endpoint are not supported"],
			[a, "Invalid Configuration: Dualstack and custom endpoint are not supported"],
			[h, k],
			["https://{Region}.signin.aws.amazon.com", k],
			["https://{Region}.signin.amazonaws.cn", k],
			["https://{Region}.signin.amazonaws-us-gov.com", k],
			["https://signin-fips.{Region}.{PartitionResult#dualStackDnsSuffix}", k],
			[a, "FIPS and DualStack are enabled, but this partition does not support one or both"],
			["https://signin-fips.{Region}.{PartitionResult#dnsSuffix}", k],
			[a, "FIPS is enabled but this partition does not support FIPS"],
			["https://signin.{Region}.{PartitionResult#dualStackDnsSuffix}", k],
			[a, "DualStack is enabled but this partition does not support DualStack"],
			["https://signin.{Region}.{PartitionResult#dnsSuffix}", k],
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
		15,
		3,
		1,
		4,
		r + 14,
		2,
		5,
		r + 14,
		3,
		11,
		6,
		4,
		10,
		7,
		7,
		r + 4,
		8,
		8,
		r + 5,
		9,
		9,
		r + 6,
		r + 13,
		5,
		r + 11,
		r + 12,
		4,
		13,
		12,
		6,
		r + 9,
		r + 10,
		5,
		14,
		r + 8,
		6,
		r + 7,
		r + 8,
		3,
		r + 1,
		16,
		4,
		r + 2,
		r + 3
	]);
	bdd = import_dist_cjs$32.BinaryDecisionDiagram.from(nodes, root, _data.conditions, _data.results);
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/signin/endpoint/endpointResolver.js
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
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/signin/models/SigninServiceException.js
var import_dist_cjs$29, SigninServiceException;
var init_SigninServiceException = __esmMin((() => {
	import_dist_cjs$29 = require_dist_cjs$22();
	SigninServiceException = class SigninServiceException extends import_dist_cjs$29.ServiceException {
		constructor(options) {
			super(options);
			Object.setPrototypeOf(this, SigninServiceException.prototype);
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/signin/models/errors.js
var AccessDeniedException, InternalServerException, TooManyRequestsError, ValidationException;
var init_errors = __esmMin((() => {
	init_SigninServiceException();
	AccessDeniedException = class AccessDeniedException extends SigninServiceException {
		name = "AccessDeniedException";
		$fault = "client";
		error;
		constructor(opts) {
			super({
				name: "AccessDeniedException",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, AccessDeniedException.prototype);
			this.error = opts.error;
		}
	};
	InternalServerException = class InternalServerException extends SigninServiceException {
		name = "InternalServerException";
		$fault = "server";
		error;
		constructor(opts) {
			super({
				name: "InternalServerException",
				$fault: "server",
				...opts
			});
			Object.setPrototypeOf(this, InternalServerException.prototype);
			this.error = opts.error;
		}
	};
	TooManyRequestsError = class TooManyRequestsError extends SigninServiceException {
		name = "TooManyRequestsError";
		$fault = "client";
		error;
		constructor(opts) {
			super({
				name: "TooManyRequestsError",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, TooManyRequestsError.prototype);
			this.error = opts.error;
		}
	};
	ValidationException = class ValidationException extends SigninServiceException {
		name = "ValidationException";
		$fault = "client";
		error;
		constructor(opts) {
			super({
				name: "ValidationException",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, ValidationException.prototype);
			this.error = opts.error;
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/signin/schemas/schemas_0.js
var _ADE, _AT, _COAT, _COATR, _COATRB, _COATRBr, _COATRr, _ISE, _RT, _TMRE, _VE, _aKI, _aT, _c, _cI, _cV, _co, _e, _eI, _gT, _h, _hE, _iT, _jN, _m, _rT, _rU, _s, _sAK, _sT, _se, _tI, _tO, _tT, n0, _s_registry, SigninServiceException$, n0_registry, AccessDeniedException$, InternalServerException$, TooManyRequestsError$, ValidationException$, errorTypeRegistries, RefreshToken, AccessToken$, CreateOAuth2TokenRequest$, CreateOAuth2TokenRequestBody$, CreateOAuth2TokenResponse$, CreateOAuth2TokenResponseBody$, CreateOAuth2Token$;
var init_schemas_0 = __esmMin((() => {
	init_schema();
	init_errors();
	init_SigninServiceException();
	_ADE = "AccessDeniedException";
	_AT = "AccessToken";
	_COAT = "CreateOAuth2Token";
	_COATR = "CreateOAuth2TokenRequest";
	_COATRB = "CreateOAuth2TokenRequestBody";
	_COATRBr = "CreateOAuth2TokenResponseBody";
	_COATRr = "CreateOAuth2TokenResponse";
	_ISE = "InternalServerException";
	_RT = "RefreshToken";
	_TMRE = "TooManyRequestsError";
	_VE = "ValidationException";
	_aKI = "accessKeyId";
	_aT = "accessToken";
	_c = "client";
	_cI = "clientId";
	_cV = "codeVerifier";
	_co = "code";
	_e = "error";
	_eI = "expiresIn";
	_gT = "grantType";
	_h = "http";
	_hE = "httpError";
	_iT = "idToken";
	_jN = "jsonName";
	_m = "message";
	_rT = "refreshToken";
	_rU = "redirectUri";
	_s = "smithy.ts.sdk.synthetic.com.amazonaws.signin";
	_sAK = "secretAccessKey";
	_sT = "sessionToken";
	_se = "server";
	_tI = "tokenInput";
	_tO = "tokenOutput";
	_tT = "tokenType";
	n0 = "com.amazonaws.signin";
	_s_registry = TypeRegistry.for(_s);
	SigninServiceException$ = [
		-3,
		_s,
		"SigninServiceException",
		0,
		[],
		[]
	];
	_s_registry.registerError(SigninServiceException$, SigninServiceException);
	n0_registry = TypeRegistry.for(n0);
	AccessDeniedException$ = [
		-3,
		n0,
		_ADE,
		{ [_e]: _c },
		[_e, _m],
		[0, 0],
		2
	];
	n0_registry.registerError(AccessDeniedException$, AccessDeniedException);
	InternalServerException$ = [
		-3,
		n0,
		_ISE,
		{
			[_e]: _se,
			[_hE]: 500
		},
		[_e, _m],
		[0, 0],
		2
	];
	n0_registry.registerError(InternalServerException$, InternalServerException);
	TooManyRequestsError$ = [
		-3,
		n0,
		_TMRE,
		{
			[_e]: _c,
			[_hE]: 429
		},
		[_e, _m],
		[0, 0],
		2
	];
	n0_registry.registerError(TooManyRequestsError$, TooManyRequestsError);
	ValidationException$ = [
		-3,
		n0,
		_VE,
		{
			[_e]: _c,
			[_hE]: 400
		},
		[_e, _m],
		[0, 0],
		2
	];
	n0_registry.registerError(ValidationException$, ValidationException);
	errorTypeRegistries = [_s_registry, n0_registry];
	RefreshToken = [
		0,
		n0,
		_RT,
		8,
		0
	];
	AccessToken$ = [
		3,
		n0,
		_AT,
		8,
		[
			_aKI,
			_sAK,
			_sT
		],
		[
			[0, { [_jN]: _aKI }],
			[0, { [_jN]: _sAK }],
			[0, { [_jN]: _sT }]
		],
		3
	];
	CreateOAuth2TokenRequest$ = [
		3,
		n0,
		_COATR,
		0,
		[_tI],
		[[() => CreateOAuth2TokenRequestBody$, 16]],
		1
	];
	CreateOAuth2TokenRequestBody$ = [
		3,
		n0,
		_COATRB,
		0,
		[
			_cI,
			_gT,
			_co,
			_rU,
			_cV,
			_rT
		],
		[
			[0, { [_jN]: _cI }],
			[0, { [_jN]: _gT }],
			0,
			[0, { [_jN]: _rU }],
			[0, { [_jN]: _cV }],
			[() => RefreshToken, { [_jN]: _rT }]
		],
		2
	];
	CreateOAuth2TokenResponse$ = [
		3,
		n0,
		_COATRr,
		0,
		[_tO],
		[[() => CreateOAuth2TokenResponseBody$, 16]],
		1
	];
	CreateOAuth2TokenResponseBody$ = [
		3,
		n0,
		_COATRBr,
		0,
		[
			_aT,
			_tT,
			_eI,
			_rT,
			_iT
		],
		[
			[() => AccessToken$, { [_jN]: _aT }],
			[0, { [_jN]: _tT }],
			[1, { [_jN]: _eI }],
			[() => RefreshToken, { [_jN]: _rT }],
			[0, { [_jN]: _iT }]
		],
		4
	];
	CreateOAuth2Token$ = [
		9,
		n0,
		_COAT,
		{ [_h]: [
			"POST",
			"/v1/token",
			200
		] },
		() => CreateOAuth2TokenRequest$,
		() => CreateOAuth2TokenResponse$
	];
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/signin/runtimeConfig.shared.js
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
			apiVersion: "2023-01-01",
			base64Decoder: config?.base64Decoder ?? import_dist_cjs$27.fromBase64,
			base64Encoder: config?.base64Encoder ?? import_dist_cjs$27.toBase64,
			disableHostPrefix: config?.disableHostPrefix ?? false,
			endpointProvider: config?.endpointProvider ?? defaultEndpointResolver,
			extensions: config?.extensions ?? [],
			httpAuthSchemeProvider: config?.httpAuthSchemeProvider ?? defaultSigninHttpAuthSchemeProvider,
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
				defaultNamespace: "com.amazonaws.signin",
				errorTypeRegistries,
				version: "2023-01-01",
				serviceTarget: "Signin"
			},
			serviceId: config?.serviceId ?? "Signin",
			urlParser: config?.urlParser ?? import_dist_cjs$26.parseUrl,
			utf8Decoder: config?.utf8Decoder ?? import_dist_cjs$28.fromUtf8,
			utf8Encoder: config?.utf8Encoder ?? import_dist_cjs$28.toUtf8
		};
	};
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/signin/runtimeConfig.js
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
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/signin/auth/httpAuthExtensionConfiguration.js
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
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/signin/runtimeExtensions.js
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
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/signin/SigninClient.js
var import_dist_cjs$3, import_dist_cjs$4, import_dist_cjs$5, import_dist_cjs$6, import_dist_cjs$7, import_dist_cjs$8, import_dist_cjs$9, import_dist_cjs$10, import_dist_cjs$11, SigninClient;
var init_SigninClient = __esmMin((() => {
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
	SigninClient = class extends import_dist_cjs$11.Client {
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
				httpAuthSchemeParametersProvider: defaultSigninHttpAuthSchemeParametersProvider,
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
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/signin/commands/CreateOAuth2TokenCommand.js
var import_dist_cjs$1, import_dist_cjs$2, CreateOAuth2TokenCommand;
var init_CreateOAuth2TokenCommand = __esmMin((() => {
	import_dist_cjs$1 = require_dist_cjs$21();
	import_dist_cjs$2 = require_dist_cjs$22();
	init_EndpointParameters();
	init_schemas_0();
	CreateOAuth2TokenCommand = class extends import_dist_cjs$2.Command.classBuilder().ep(commonParams).m(function(Command, cs, config, o) {
		return [(0, import_dist_cjs$1.getEndpointPlugin)(config, Command.getEndpointParameterInstructions())];
	}).s("Signin", "CreateOAuth2Token", {}).n("SigninClient", "CreateOAuth2TokenCommand").sc(CreateOAuth2Token$).build() {};
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/signin/Signin.js
var import_dist_cjs, commands, Signin;
var init_Signin = __esmMin((() => {
	import_dist_cjs = require_dist_cjs$22();
	init_CreateOAuth2TokenCommand();
	init_SigninClient();
	commands = { CreateOAuth2TokenCommand };
	Signin = class extends SigninClient {};
	(0, import_dist_cjs.createAggregatedClient)(commands, Signin);
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/signin/commands/index.js
var init_commands = __esmMin((() => {
	init_CreateOAuth2TokenCommand();
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/signin/models/enums.js
var init_enums = __esmMin((() => {}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/signin/models/models_0.js
var init_models_0 = __esmMin((() => {}));
//#endregion
__esmMin((() => {
	init_SigninClient();
	init_Signin();
	init_commands();
	init_schemas_0();
	init_enums();
	init_errors();
	init_models_0();
	init_SigninServiceException();
}))();
export { CreateOAuth2TokenCommand, SigninClient };
