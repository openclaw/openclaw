import { n as __esmMin, r as __exportAll } from "./chunk-HkwdBwDg.js";
import { A as getSchemaSerdePlugin, E as init_schema, O as TypeRegistry } from "./protocols-CO3NMy6S.js";
import { t as require_dist_cjs } from "./dist-cjs-DQR3Meck.js";
import { c as emitWarningIfUnsupportedVersion$1, i as require_dist_cjs$1, r as init_client, s as setCredentialFeature } from "./dist-cjs-DS9W42km.js";
import { B as require_dist_cjs$8, D as getHttpSigningPlugin, E as DefaultIdentityProviderConfig, F as require_dist_cjs$7, I as require_dist_cjs$19, L as require_dist_cjs$18, N as AwsQueryProtocol, O as getHttpAuthSchemeEndpointRuleSetPlugin, R as require_dist_cjs$17, S as require_dist_cjs$2, T as NoAuthSigner, _ as require_dist_cjs$21, a as require_dist_cjs$11, b as require_dist_cjs$3, c as init_httpAuthSchemes, d as resolveAwsSdkSigV4AConfig, f as NODE_AUTH_SCHEME_PREFERENCE_OPTIONS, g as require_dist_cjs$4, h as require_dist_cjs$12, i as require_dist_cjs$13, j as init_protocols, l as resolveAwsSdkSigV4Config, m as AwsSdkSigV4Signer, n as require_dist_cjs$15, o as require_dist_cjs$9, p as AwsSdkSigV4ASigner, r as require_dist_cjs$14, t as require_dist_cjs$16, u as NODE_SIGV4A_CONFIG_OPTIONS, v as require_dist_cjs$10, w as init_dist_es, x as require_dist_cjs$6, y as require_dist_cjs$20, z as require_dist_cjs$5 } from "./dist-cjs-D0pP6SUX.js";
import { n as require_dist_cjs$22, t as require_dist_cjs$23 } from "./dist-cjs-DDGLQYvl.js";
import { t as require_dist_cjs$24 } from "./dist-cjs-C7XdY3cd.js";
import { t as version } from "./package-CNqrm-wp.js";
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sts/endpoint/bdd.js
var import_dist_cjs$39, q, a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p, _data, root, r, nodes, bdd;
var init_bdd = __esmMin((() => {
	import_dist_cjs$39 = require_dist_cjs$2();
	q = "ref";
	a = -1, b = true, c = "isSet", d = "PartitionResult", e = "booleanEquals", f = "stringEquals", g = "getAttr", h = "us-east-1", i = "sigv4", j = "sts", k = "https://sts.{Region}.{PartitionResult#dnsSuffix}", l = { [q]: "Endpoint" }, m = { [q]: "Region" }, n = { [q]: d }, o = {}, p = [m];
	_data = {
		conditions: [
			[c, [l]],
			[c, p],
			[
				"aws.partition",
				p,
				d
			],
			[e, [{ [q]: "UseFIPS" }, b]],
			[e, [{ [q]: "UseDualStack" }, b]],
			[f, [m, "aws-global"]],
			[e, [{ [q]: "UseGlobalEndpoint" }, b]],
			[f, [m, "eu-central-1"]],
			[e, [{
				fn: g,
				argv: [n, "supportsDualStack"]
			}, b]],
			[e, [{
				fn: g,
				argv: [n, "supportsFIPS"]
			}, b]],
			[f, [m, "ap-south-1"]],
			[f, [m, "eu-north-1"]],
			[f, [m, "eu-west-1"]],
			[f, [m, "eu-west-2"]],
			[f, [m, "eu-west-3"]],
			[f, [m, "sa-east-1"]],
			[f, [m, h]],
			[f, [m, "us-east-2"]],
			[f, [m, "us-west-2"]],
			[f, [m, "us-west-1"]],
			[f, [m, "ca-central-1"]],
			[f, [m, "ap-southeast-1"]],
			[f, [m, "ap-northeast-1"]],
			[f, [m, "ap-southeast-2"]],
			[f, [{
				fn: g,
				argv: [n, "name"]
			}, "aws-us-gov"]]
		],
		results: [
			[a],
			["https://sts.amazonaws.com", { authSchemes: [{
				name: i,
				signingName: j,
				signingRegion: h
			}] }],
			[k, { authSchemes: [{
				name: i,
				signingName: j,
				signingRegion: "{Region}"
			}] }],
			[a, "Invalid Configuration: FIPS and custom endpoint are not supported"],
			[a, "Invalid Configuration: Dualstack and custom endpoint are not supported"],
			[l, o],
			["https://sts-fips.{Region}.{PartitionResult#dualStackDnsSuffix}", o],
			[a, "FIPS and DualStack are enabled, but this partition does not support one or both"],
			["https://sts.{Region}.amazonaws.com", o],
			["https://sts-fips.{Region}.{PartitionResult#dnsSuffix}", o],
			[a, "FIPS is enabled but this partition does not support FIPS"],
			["https://sts.{Region}.{PartitionResult#dualStackDnsSuffix}", o],
			[a, "DualStack is enabled but this partition does not support DualStack"],
			[k, o],
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
		30,
		3,
		1,
		4,
		r + 14,
		2,
		5,
		r + 14,
		3,
		25,
		6,
		4,
		24,
		7,
		5,
		r + 1,
		8,
		6,
		9,
		r + 13,
		7,
		r + 1,
		10,
		10,
		r + 1,
		11,
		11,
		r + 1,
		12,
		12,
		r + 1,
		13,
		13,
		r + 1,
		14,
		14,
		r + 1,
		15,
		15,
		r + 1,
		16,
		16,
		r + 1,
		17,
		17,
		r + 1,
		18,
		18,
		r + 1,
		19,
		19,
		r + 1,
		20,
		20,
		r + 1,
		21,
		21,
		r + 1,
		22,
		22,
		r + 1,
		23,
		23,
		r + 1,
		r + 2,
		8,
		r + 11,
		r + 12,
		4,
		28,
		26,
		9,
		27,
		r + 10,
		24,
		r + 8,
		r + 9,
		8,
		29,
		r + 7,
		9,
		r + 6,
		r + 7,
		3,
		r + 3,
		31,
		4,
		r + 4,
		r + 5
	]);
	bdd = import_dist_cjs$39.BinaryDecisionDiagram.from(nodes, root, _data.conditions, _data.results);
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sts/endpoint/endpointResolver.js
var import_dist_cjs$37, import_dist_cjs$38, cache, defaultEndpointResolver;
var init_endpointResolver = __esmMin((() => {
	import_dist_cjs$37 = require_dist_cjs$3();
	import_dist_cjs$38 = require_dist_cjs$2();
	init_bdd();
	cache = new import_dist_cjs$38.EndpointCache({
		size: 50,
		params: [
			"Endpoint",
			"Region",
			"UseDualStack",
			"UseFIPS",
			"UseGlobalEndpoint"
		]
	});
	defaultEndpointResolver = (endpointParams, context = {}) => {
		return cache.get(endpointParams, () => (0, import_dist_cjs$38.decideEndpoint)(bdd, {
			endpointParams,
			logger: context.logger
		}));
	};
	import_dist_cjs$38.customEndpointFunctions.aws = import_dist_cjs$37.awsEndpointFunctions;
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sts/auth/httpAuthSchemeProvider.js
function createAwsAuthSigv4HttpAuthOption(authParameters) {
	return {
		schemeId: "aws.auth#sigv4",
		signingProperties: {
			name: "sts",
			region: authParameters.region
		},
		propertiesExtractor: (config, context) => ({ signingProperties: {
			config,
			context
		} })
	};
}
function createAwsAuthSigv4aHttpAuthOption(authParameters) {
	return {
		schemeId: "aws.auth#sigv4a",
		signingProperties: {
			name: "sts",
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
var import_dist_cjs$34, import_dist_cjs$35, import_dist_cjs$36, createEndpointRuleSetHttpAuthSchemeParametersProvider, _defaultSTSHttpAuthSchemeParametersProvider, defaultSTSHttpAuthSchemeParametersProvider, createEndpointRuleSetHttpAuthSchemeProvider, _defaultSTSHttpAuthSchemeProvider, defaultSTSHttpAuthSchemeProvider, resolveStsAuthConfig, resolveHttpAuthSchemeConfig;
var init_httpAuthSchemeProvider = __esmMin((() => {
	init_httpAuthSchemes();
	import_dist_cjs$34 = require_dist_cjs$24();
	import_dist_cjs$35 = require_dist_cjs$4();
	import_dist_cjs$36 = require_dist_cjs$5();
	init_endpointResolver();
	init_STSClient();
	createEndpointRuleSetHttpAuthSchemeParametersProvider = (defaultHttpAuthSchemeParametersProvider) => async (config, context, input) => {
		if (!input) throw new Error("Could not find `input` for `defaultEndpointRuleSetHttpAuthSchemeParametersProvider`");
		const defaultParameters = await defaultHttpAuthSchemeParametersProvider(config, context, input);
		const instructionsFn = (0, import_dist_cjs$36.getSmithyContext)(context)?.commandInstance?.constructor?.getEndpointParameterInstructions;
		if (!instructionsFn) throw new Error(`getEndpointParameterInstructions() is not defined on '${context.commandName}'`);
		const endpointParameters = await (0, import_dist_cjs$35.resolveParams)(input, { getEndpointParameterInstructions: instructionsFn }, config);
		return Object.assign(defaultParameters, endpointParameters);
	};
	_defaultSTSHttpAuthSchemeParametersProvider = async (config, context, input) => {
		return {
			operation: (0, import_dist_cjs$36.getSmithyContext)(context).operation,
			region: await (0, import_dist_cjs$36.normalizeProvider)(config.region)() || (() => {
				throw new Error("expected `region` to be configured for `aws.auth#sigv4`");
			})()
		};
	};
	defaultSTSHttpAuthSchemeParametersProvider = createEndpointRuleSetHttpAuthSchemeParametersProvider(_defaultSTSHttpAuthSchemeParametersProvider);
	createEndpointRuleSetHttpAuthSchemeProvider = (defaultEndpointResolver, defaultHttpAuthSchemeResolver, createHttpAuthOptionFunctions) => {
		const endpointRuleSetHttpAuthSchemeProvider = (authParameters) => {
			const authSchemes = defaultEndpointResolver(authParameters).properties?.authSchemes;
			if (!authSchemes) return defaultHttpAuthSchemeResolver(authParameters);
			const options = [];
			for (const scheme of authSchemes) {
				const { name: resolvedName, properties = {}, ...rest } = scheme;
				const name = resolvedName.toLowerCase();
				if (resolvedName !== name) console.warn(`HttpAuthScheme has been normalized with lowercasing: '${resolvedName}' to '${name}'`);
				let schemeId;
				if (name === "sigv4a") {
					schemeId = "aws.auth#sigv4a";
					const sigv4Present = authSchemes.find((s) => {
						const name = s.name.toLowerCase();
						return name !== "sigv4a" && name.startsWith("sigv4");
					});
					if (import_dist_cjs$34.SignatureV4MultiRegion.sigv4aDependency() === "none" && sigv4Present) continue;
				} else if (name.startsWith("sigv4")) schemeId = "aws.auth#sigv4";
				else throw new Error(`Unknown HttpAuthScheme found in '@smithy.rules#endpointRuleSet': '${name}'`);
				const createOption = createHttpAuthOptionFunctions[schemeId];
				if (!createOption) throw new Error(`Could not find HttpAuthOption create function for '${schemeId}'`);
				const option = createOption(authParameters);
				option.schemeId = schemeId;
				option.signingProperties = {
					...option.signingProperties || {},
					...rest,
					...properties
				};
				options.push(option);
			}
			return options;
		};
		return endpointRuleSetHttpAuthSchemeProvider;
	};
	_defaultSTSHttpAuthSchemeProvider = (authParameters) => {
		const options = [];
		switch (authParameters.operation) {
			case "AssumeRoleWithWebIdentity":
				options.push(createSmithyApiNoAuthHttpAuthOption(authParameters));
				options.push(createAwsAuthSigv4aHttpAuthOption(authParameters));
				break;
			default:
				options.push(createAwsAuthSigv4HttpAuthOption(authParameters));
				options.push(createAwsAuthSigv4aHttpAuthOption(authParameters));
		}
		return options;
	};
	defaultSTSHttpAuthSchemeProvider = createEndpointRuleSetHttpAuthSchemeProvider(defaultEndpointResolver, _defaultSTSHttpAuthSchemeProvider, {
		"aws.auth#sigv4": createAwsAuthSigv4HttpAuthOption,
		"aws.auth#sigv4a": createAwsAuthSigv4aHttpAuthOption,
		"smithy.api#noAuth": createSmithyApiNoAuthHttpAuthOption
	});
	resolveStsAuthConfig = (input) => Object.assign(input, { stsClientCtor: STSClient });
	resolveHttpAuthSchemeConfig = (config) => {
		const config_2 = resolveAwsSdkSigV4AConfig(resolveAwsSdkSigV4Config(resolveStsAuthConfig(config)));
		return Object.assign(config_2, { authSchemePreference: (0, import_dist_cjs$36.normalizeProvider)(config.authSchemePreference ?? []) });
	};
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sts/endpoint/EndpointParameters.js
var resolveClientEndpointParameters, commonParams;
var init_EndpointParameters = __esmMin((() => {
	resolveClientEndpointParameters = (options) => {
		return Object.assign(options, {
			useDualstackEndpoint: options.useDualstackEndpoint ?? false,
			useFipsEndpoint: options.useFipsEndpoint ?? false,
			useGlobalEndpoint: options.useGlobalEndpoint ?? false,
			defaultSigningName: "sts"
		});
	};
	commonParams = {
		UseGlobalEndpoint: {
			type: "builtInParams",
			name: "useGlobalEndpoint"
		},
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
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sts/models/STSServiceException.js
var import_dist_cjs$33, STSServiceException;
var init_STSServiceException = __esmMin((() => {
	import_dist_cjs$33 = require_dist_cjs$22();
	STSServiceException = class STSServiceException extends import_dist_cjs$33.ServiceException {
		constructor(options) {
			super(options);
			Object.setPrototypeOf(this, STSServiceException.prototype);
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sts/models/errors.js
var ExpiredTokenException, MalformedPolicyDocumentException, PackedPolicyTooLargeException, RegionDisabledException, IDPRejectedClaimException, InvalidIdentityTokenException, IDPCommunicationErrorException;
var init_errors = __esmMin((() => {
	init_STSServiceException();
	ExpiredTokenException = class ExpiredTokenException extends STSServiceException {
		name = "ExpiredTokenException";
		$fault = "client";
		constructor(opts) {
			super({
				name: "ExpiredTokenException",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, ExpiredTokenException.prototype);
		}
	};
	MalformedPolicyDocumentException = class MalformedPolicyDocumentException extends STSServiceException {
		name = "MalformedPolicyDocumentException";
		$fault = "client";
		constructor(opts) {
			super({
				name: "MalformedPolicyDocumentException",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, MalformedPolicyDocumentException.prototype);
		}
	};
	PackedPolicyTooLargeException = class PackedPolicyTooLargeException extends STSServiceException {
		name = "PackedPolicyTooLargeException";
		$fault = "client";
		constructor(opts) {
			super({
				name: "PackedPolicyTooLargeException",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, PackedPolicyTooLargeException.prototype);
		}
	};
	RegionDisabledException = class RegionDisabledException extends STSServiceException {
		name = "RegionDisabledException";
		$fault = "client";
		constructor(opts) {
			super({
				name: "RegionDisabledException",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, RegionDisabledException.prototype);
		}
	};
	IDPRejectedClaimException = class IDPRejectedClaimException extends STSServiceException {
		name = "IDPRejectedClaimException";
		$fault = "client";
		constructor(opts) {
			super({
				name: "IDPRejectedClaimException",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, IDPRejectedClaimException.prototype);
		}
	};
	InvalidIdentityTokenException = class InvalidIdentityTokenException extends STSServiceException {
		name = "InvalidIdentityTokenException";
		$fault = "client";
		constructor(opts) {
			super({
				name: "InvalidIdentityTokenException",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, InvalidIdentityTokenException.prototype);
		}
	};
	IDPCommunicationErrorException = class IDPCommunicationErrorException extends STSServiceException {
		name = "IDPCommunicationErrorException";
		$fault = "client";
		$retryable = {};
		constructor(opts) {
			super({
				name: "IDPCommunicationErrorException",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, IDPCommunicationErrorException.prototype);
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sts/schemas/schemas_0.js
var _A, _AKI, _AR, _ARI, _ARR, _ARRs, _ARU, _ARWWI, _ARWWIR, _ARWWIRs, _Au, _C, _CA, _DS, _E, _EI, _ETE, _IDPCEE, _IDPRCE, _IITE, _K, _MPDE, _P, _PA, _PAr, _PC, _PCLT, _PCr, _PDT, _PI, _PPS, _PPTLE, _Pr, _RA, _RDE, _RSN, _SAK, _SFWIT, _SI, _SN, _ST, _T, _TC, _TTK, _Ta, _V, _WIT, _a, _aKST, _aQE, _c, _cTT, _e, _hE, _m, _pDLT, _s, _tLT, n0, _s_registry, STSServiceException$, n0_registry, ExpiredTokenException$, IDPCommunicationErrorException$, IDPRejectedClaimException$, InvalidIdentityTokenException$, MalformedPolicyDocumentException$, PackedPolicyTooLargeException$, RegionDisabledException$, errorTypeRegistries, accessKeySecretType, clientTokenType, AssumedRoleUser$, AssumeRoleRequest$, AssumeRoleResponse$, AssumeRoleWithWebIdentityRequest$, AssumeRoleWithWebIdentityResponse$, Credentials$, PolicyDescriptorType$, ProvidedContext$, Tag$, policyDescriptorListType, ProvidedContextsListType, tagListType, AssumeRole$, AssumeRoleWithWebIdentity$;
var init_schemas_0 = __esmMin((() => {
	init_schema();
	init_errors();
	init_STSServiceException();
	_A = "Arn";
	_AKI = "AccessKeyId";
	_AR = "AssumeRole";
	_ARI = "AssumedRoleId";
	_ARR = "AssumeRoleRequest";
	_ARRs = "AssumeRoleResponse";
	_ARU = "AssumedRoleUser";
	_ARWWI = "AssumeRoleWithWebIdentity";
	_ARWWIR = "AssumeRoleWithWebIdentityRequest";
	_ARWWIRs = "AssumeRoleWithWebIdentityResponse";
	_Au = "Audience";
	_C = "Credentials";
	_CA = "ContextAssertion";
	_DS = "DurationSeconds";
	_E = "Expiration";
	_EI = "ExternalId";
	_ETE = "ExpiredTokenException";
	_IDPCEE = "IDPCommunicationErrorException";
	_IDPRCE = "IDPRejectedClaimException";
	_IITE = "InvalidIdentityTokenException";
	_K = "Key";
	_MPDE = "MalformedPolicyDocumentException";
	_P = "Policy";
	_PA = "PolicyArns";
	_PAr = "ProviderArn";
	_PC = "ProvidedContexts";
	_PCLT = "ProvidedContextsListType";
	_PCr = "ProvidedContext";
	_PDT = "PolicyDescriptorType";
	_PI = "ProviderId";
	_PPS = "PackedPolicySize";
	_PPTLE = "PackedPolicyTooLargeException";
	_Pr = "Provider";
	_RA = "RoleArn";
	_RDE = "RegionDisabledException";
	_RSN = "RoleSessionName";
	_SAK = "SecretAccessKey";
	_SFWIT = "SubjectFromWebIdentityToken";
	_SI = "SourceIdentity";
	_SN = "SerialNumber";
	_ST = "SessionToken";
	_T = "Tags";
	_TC = "TokenCode";
	_TTK = "TransitiveTagKeys";
	_Ta = "Tag";
	_V = "Value";
	_WIT = "WebIdentityToken";
	_a = "arn";
	_aKST = "accessKeySecretType";
	_aQE = "awsQueryError";
	_c = "client";
	_cTT = "clientTokenType";
	_e = "error";
	_hE = "httpError";
	_m = "message";
	_pDLT = "policyDescriptorListType";
	_s = "smithy.ts.sdk.synthetic.com.amazonaws.sts";
	_tLT = "tagListType";
	n0 = "com.amazonaws.sts";
	_s_registry = TypeRegistry.for(_s);
	STSServiceException$ = [
		-3,
		_s,
		"STSServiceException",
		0,
		[],
		[]
	];
	_s_registry.registerError(STSServiceException$, STSServiceException);
	n0_registry = TypeRegistry.for(n0);
	ExpiredTokenException$ = [
		-3,
		n0,
		_ETE,
		{
			[_aQE]: [`ExpiredTokenException`, 400],
			[_e]: _c,
			[_hE]: 400
		},
		[_m],
		[0]
	];
	n0_registry.registerError(ExpiredTokenException$, ExpiredTokenException);
	IDPCommunicationErrorException$ = [
		-3,
		n0,
		_IDPCEE,
		{
			[_aQE]: [`IDPCommunicationError`, 400],
			[_e]: _c,
			[_hE]: 400
		},
		[_m],
		[0]
	];
	n0_registry.registerError(IDPCommunicationErrorException$, IDPCommunicationErrorException);
	IDPRejectedClaimException$ = [
		-3,
		n0,
		_IDPRCE,
		{
			[_aQE]: [`IDPRejectedClaim`, 403],
			[_e]: _c,
			[_hE]: 403
		},
		[_m],
		[0]
	];
	n0_registry.registerError(IDPRejectedClaimException$, IDPRejectedClaimException);
	InvalidIdentityTokenException$ = [
		-3,
		n0,
		_IITE,
		{
			[_aQE]: [`InvalidIdentityToken`, 400],
			[_e]: _c,
			[_hE]: 400
		},
		[_m],
		[0]
	];
	n0_registry.registerError(InvalidIdentityTokenException$, InvalidIdentityTokenException);
	MalformedPolicyDocumentException$ = [
		-3,
		n0,
		_MPDE,
		{
			[_aQE]: [`MalformedPolicyDocument`, 400],
			[_e]: _c,
			[_hE]: 400
		},
		[_m],
		[0]
	];
	n0_registry.registerError(MalformedPolicyDocumentException$, MalformedPolicyDocumentException);
	PackedPolicyTooLargeException$ = [
		-3,
		n0,
		_PPTLE,
		{
			[_aQE]: [`PackedPolicyTooLarge`, 400],
			[_e]: _c,
			[_hE]: 400
		},
		[_m],
		[0]
	];
	n0_registry.registerError(PackedPolicyTooLargeException$, PackedPolicyTooLargeException);
	RegionDisabledException$ = [
		-3,
		n0,
		_RDE,
		{
			[_aQE]: [`RegionDisabledException`, 403],
			[_e]: _c,
			[_hE]: 403
		},
		[_m],
		[0]
	];
	n0_registry.registerError(RegionDisabledException$, RegionDisabledException);
	errorTypeRegistries = [_s_registry, n0_registry];
	accessKeySecretType = [
		0,
		n0,
		_aKST,
		8,
		0
	];
	clientTokenType = [
		0,
		n0,
		_cTT,
		8,
		0
	];
	AssumedRoleUser$ = [
		3,
		n0,
		_ARU,
		0,
		[_ARI, _A],
		[0, 0],
		2
	];
	AssumeRoleRequest$ = [
		3,
		n0,
		_ARR,
		0,
		[
			_RA,
			_RSN,
			_PA,
			_P,
			_DS,
			_T,
			_TTK,
			_EI,
			_SN,
			_TC,
			_SI,
			_PC
		],
		[
			0,
			0,
			() => policyDescriptorListType,
			0,
			1,
			() => tagListType,
			64,
			0,
			0,
			0,
			0,
			() => ProvidedContextsListType
		],
		2
	];
	AssumeRoleResponse$ = [
		3,
		n0,
		_ARRs,
		0,
		[
			_C,
			_ARU,
			_PPS,
			_SI
		],
		[
			[() => Credentials$, 0],
			() => AssumedRoleUser$,
			1,
			0
		]
	];
	AssumeRoleWithWebIdentityRequest$ = [
		3,
		n0,
		_ARWWIR,
		0,
		[
			_RA,
			_RSN,
			_WIT,
			_PI,
			_PA,
			_P,
			_DS
		],
		[
			0,
			0,
			[() => clientTokenType, 0],
			0,
			() => policyDescriptorListType,
			0,
			1
		],
		3
	];
	AssumeRoleWithWebIdentityResponse$ = [
		3,
		n0,
		_ARWWIRs,
		0,
		[
			_C,
			_SFWIT,
			_ARU,
			_PPS,
			_Pr,
			_Au,
			_SI
		],
		[
			[() => Credentials$, 0],
			0,
			() => AssumedRoleUser$,
			1,
			0,
			0,
			0
		]
	];
	Credentials$ = [
		3,
		n0,
		_C,
		0,
		[
			_AKI,
			_SAK,
			_ST,
			_E
		],
		[
			0,
			[() => accessKeySecretType, 0],
			0,
			4
		],
		4
	];
	PolicyDescriptorType$ = [
		3,
		n0,
		_PDT,
		0,
		[_a],
		[0]
	];
	ProvidedContext$ = [
		3,
		n0,
		_PCr,
		0,
		[_PAr, _CA],
		[0, 0]
	];
	Tag$ = [
		3,
		n0,
		_Ta,
		0,
		[_K, _V],
		[0, 0],
		2
	];
	policyDescriptorListType = [
		1,
		n0,
		_pDLT,
		0,
		() => PolicyDescriptorType$
	];
	ProvidedContextsListType = [
		1,
		n0,
		_PCLT,
		0,
		() => ProvidedContext$
	];
	tagListType = [
		1,
		n0,
		_tLT,
		0,
		() => Tag$
	];
	AssumeRole$ = [
		9,
		n0,
		_AR,
		0,
		() => AssumeRoleRequest$,
		() => AssumeRoleResponse$
	];
	AssumeRoleWithWebIdentity$ = [
		9,
		n0,
		_ARWWI,
		0,
		() => AssumeRoleWithWebIdentityRequest$,
		() => AssumeRoleWithWebIdentityResponse$
	];
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sts/runtimeConfig.shared.js
var import_dist_cjs$28, import_dist_cjs$29, import_dist_cjs$30, import_dist_cjs$31, import_dist_cjs$32, getRuntimeConfig$1;
var init_runtimeConfig_shared = __esmMin((() => {
	init_httpAuthSchemes();
	init_protocols();
	import_dist_cjs$28 = require_dist_cjs$24();
	init_dist_es();
	import_dist_cjs$29 = require_dist_cjs$22();
	import_dist_cjs$30 = require_dist_cjs$6();
	import_dist_cjs$31 = require_dist_cjs$7();
	import_dist_cjs$32 = require_dist_cjs$8();
	init_httpAuthSchemeProvider();
	init_endpointResolver();
	init_schemas_0();
	getRuntimeConfig$1 = (config) => {
		return {
			apiVersion: "2011-06-15",
			base64Decoder: config?.base64Decoder ?? import_dist_cjs$31.fromBase64,
			base64Encoder: config?.base64Encoder ?? import_dist_cjs$31.toBase64,
			disableHostPrefix: config?.disableHostPrefix ?? false,
			endpointProvider: config?.endpointProvider ?? defaultEndpointResolver,
			extensions: config?.extensions ?? [],
			httpAuthSchemeProvider: config?.httpAuthSchemeProvider ?? defaultSTSHttpAuthSchemeProvider,
			httpAuthSchemes: config?.httpAuthSchemes ?? [
				{
					schemeId: "aws.auth#sigv4",
					identityProvider: (ipc) => ipc.getIdentityProvider("aws.auth#sigv4"),
					signer: new AwsSdkSigV4Signer()
				},
				{
					schemeId: "aws.auth#sigv4a",
					identityProvider: (ipc) => ipc.getIdentityProvider("aws.auth#sigv4a"),
					signer: new AwsSdkSigV4ASigner()
				},
				{
					schemeId: "smithy.api#noAuth",
					identityProvider: (ipc) => ipc.getIdentityProvider("smithy.api#noAuth") || (async () => ({})),
					signer: new NoAuthSigner()
				}
			],
			logger: config?.logger ?? new import_dist_cjs$29.NoOpLogger(),
			protocol: config?.protocol ?? AwsQueryProtocol,
			protocolSettings: config?.protocolSettings ?? {
				defaultNamespace: "com.amazonaws.sts",
				errorTypeRegistries,
				xmlNamespace: "https://sts.amazonaws.com/doc/2011-06-15/",
				version: "2011-06-15",
				serviceTarget: "AWSSecurityTokenServiceV20110615"
			},
			serviceId: config?.serviceId ?? "STS",
			signerConstructor: config?.signerConstructor ?? import_dist_cjs$28.SignatureV4MultiRegion,
			urlParser: config?.urlParser ?? import_dist_cjs$30.parseUrl,
			utf8Decoder: config?.utf8Decoder ?? import_dist_cjs$32.fromUtf8,
			utf8Encoder: config?.utf8Encoder ?? import_dist_cjs$32.toUtf8
		};
	};
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sts/runtimeConfig.js
var import_dist_cjs$18, import_dist_cjs$19, import_dist_cjs$20, import_dist_cjs$21, import_dist_cjs$22, import_dist_cjs$23, import_dist_cjs$24, import_dist_cjs$25, import_dist_cjs$26, import_dist_cjs$27, getRuntimeConfig;
var init_runtimeConfig = __esmMin((() => {
	init_client();
	init_httpAuthSchemes();
	import_dist_cjs$18 = require_dist_cjs$9();
	import_dist_cjs$19 = require_dist_cjs$10();
	init_dist_es();
	import_dist_cjs$20 = require_dist_cjs$11();
	import_dist_cjs$21 = require_dist_cjs$12();
	import_dist_cjs$22 = require_dist_cjs$13();
	import_dist_cjs$23 = require_dist_cjs$23();
	import_dist_cjs$24 = require_dist_cjs$22();
	import_dist_cjs$25 = require_dist_cjs$14();
	import_dist_cjs$26 = require_dist_cjs$15();
	import_dist_cjs$27 = require_dist_cjs$1();
	init_runtimeConfig_shared();
	getRuntimeConfig = (config) => {
		(0, import_dist_cjs$24.emitWarningIfUnsupportedVersion)(process.version);
		const defaultsMode = (0, import_dist_cjs$26.resolveDefaultsModeConfig)(config);
		const defaultConfigProvider = () => defaultsMode().then(import_dist_cjs$24.loadConfigsForDefaultMode);
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
			authSchemePreference: config?.authSchemePreference ?? (0, import_dist_cjs$22.loadConfig)(NODE_AUTH_SCHEME_PREFERENCE_OPTIONS, loaderConfig),
			bodyLengthChecker: config?.bodyLengthChecker ?? import_dist_cjs$25.calculateBodyLength,
			defaultUserAgentProvider: config?.defaultUserAgentProvider ?? (0, import_dist_cjs$18.createDefaultUserAgentProvider)({
				serviceId: clientSharedValues.serviceId,
				clientVersion: version
			}),
			httpAuthSchemes: config?.httpAuthSchemes ?? [
				{
					schemeId: "aws.auth#sigv4",
					identityProvider: (ipc) => ipc.getIdentityProvider("aws.auth#sigv4") || (async (idProps) => await config.credentialDefaultProvider(idProps?.__config || {})()),
					signer: new AwsSdkSigV4Signer()
				},
				{
					schemeId: "aws.auth#sigv4a",
					identityProvider: (ipc) => ipc.getIdentityProvider("aws.auth#sigv4a"),
					signer: new AwsSdkSigV4ASigner()
				},
				{
					schemeId: "smithy.api#noAuth",
					identityProvider: (ipc) => ipc.getIdentityProvider("smithy.api#noAuth") || (async () => ({})),
					signer: new NoAuthSigner()
				}
			],
			maxAttempts: config?.maxAttempts ?? (0, import_dist_cjs$22.loadConfig)(import_dist_cjs$21.NODE_MAX_ATTEMPT_CONFIG_OPTIONS, config),
			region: config?.region ?? (0, import_dist_cjs$22.loadConfig)(import_dist_cjs$19.NODE_REGION_CONFIG_OPTIONS, {
				...import_dist_cjs$19.NODE_REGION_CONFIG_FILE_OPTIONS,
				...loaderConfig
			}),
			requestHandler: import_dist_cjs$23.NodeHttpHandler.create(config?.requestHandler ?? defaultConfigProvider),
			retryMode: config?.retryMode ?? (0, import_dist_cjs$22.loadConfig)({
				...import_dist_cjs$21.NODE_RETRY_MODE_CONFIG_OPTIONS,
				default: async () => (await defaultConfigProvider()).retryMode || import_dist_cjs$27.DEFAULT_RETRY_MODE
			}, config),
			sha256: config?.sha256 ?? import_dist_cjs$20.Hash.bind(null, "sha256"),
			sigv4aSigningRegionSet: config?.sigv4aSigningRegionSet ?? (0, import_dist_cjs$22.loadConfig)(NODE_SIGV4A_CONFIG_OPTIONS, loaderConfig),
			streamCollector: config?.streamCollector ?? import_dist_cjs$23.streamCollector,
			useDualstackEndpoint: config?.useDualstackEndpoint ?? (0, import_dist_cjs$22.loadConfig)(import_dist_cjs$19.NODE_USE_DUALSTACK_ENDPOINT_CONFIG_OPTIONS, loaderConfig),
			useFipsEndpoint: config?.useFipsEndpoint ?? (0, import_dist_cjs$22.loadConfig)(import_dist_cjs$19.NODE_USE_FIPS_ENDPOINT_CONFIG_OPTIONS, loaderConfig),
			userAgentAppId: config?.userAgentAppId ?? (0, import_dist_cjs$22.loadConfig)(import_dist_cjs$18.NODE_APP_ID_CONFIG_OPTIONS, loaderConfig)
		};
	};
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sts/auth/httpAuthExtensionConfiguration.js
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
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sts/runtimeExtensions.js
var import_dist_cjs$15, import_dist_cjs$16, import_dist_cjs$17, resolveRuntimeExtensions;
var init_runtimeExtensions = __esmMin((() => {
	import_dist_cjs$15 = require_dist_cjs$16();
	import_dist_cjs$16 = require_dist_cjs();
	import_dist_cjs$17 = require_dist_cjs$22();
	init_httpAuthExtensionConfiguration();
	resolveRuntimeExtensions = (runtimeConfig, extensions) => {
		const extensionConfiguration = Object.assign((0, import_dist_cjs$15.getAwsRegionExtensionConfiguration)(runtimeConfig), (0, import_dist_cjs$17.getDefaultExtensionConfiguration)(runtimeConfig), (0, import_dist_cjs$16.getHttpHandlerExtensionConfiguration)(runtimeConfig), getHttpAuthExtensionConfiguration(runtimeConfig));
		extensions.forEach((extension) => extension.configure(extensionConfiguration));
		return Object.assign(runtimeConfig, (0, import_dist_cjs$15.resolveAwsRegionExtensionConfiguration)(extensionConfiguration), (0, import_dist_cjs$17.resolveDefaultRuntimeConfig)(extensionConfiguration), (0, import_dist_cjs$16.resolveHttpHandlerRuntimeConfig)(extensionConfiguration), resolveHttpAuthRuntimeConfig(extensionConfiguration));
	};
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sts/STSClient.js
var import_dist_cjs$6, import_dist_cjs$7, import_dist_cjs$8, import_dist_cjs$9, import_dist_cjs$10, import_dist_cjs$11, import_dist_cjs$12, import_dist_cjs$13, import_dist_cjs$14, STSClient;
var init_STSClient = __esmMin((() => {
	import_dist_cjs$6 = require_dist_cjs$17();
	import_dist_cjs$7 = require_dist_cjs$18();
	import_dist_cjs$8 = require_dist_cjs$19();
	import_dist_cjs$9 = require_dist_cjs$20();
	import_dist_cjs$10 = require_dist_cjs$10();
	init_dist_es();
	init_schema();
	import_dist_cjs$11 = require_dist_cjs$21();
	import_dist_cjs$12 = require_dist_cjs$4();
	import_dist_cjs$13 = require_dist_cjs$12();
	import_dist_cjs$14 = require_dist_cjs$22();
	init_httpAuthSchemeProvider();
	init_EndpointParameters();
	init_runtimeConfig();
	init_runtimeExtensions();
	STSClient = class extends import_dist_cjs$14.Client {
		config;
		constructor(...[configuration]) {
			const _config_0 = getRuntimeConfig(configuration || {});
			super(_config_0);
			this.initConfig = _config_0;
			const _config_8 = resolveRuntimeExtensions(resolveHttpAuthSchemeConfig((0, import_dist_cjs$12.resolveEndpointConfig)((0, import_dist_cjs$6.resolveHostHeaderConfig)((0, import_dist_cjs$10.resolveRegionConfig)((0, import_dist_cjs$13.resolveRetryConfig)((0, import_dist_cjs$9.resolveUserAgentConfig)(resolveClientEndpointParameters(_config_0))))))), configuration?.extensions || []);
			this.config = _config_8;
			this.middlewareStack.use(getSchemaSerdePlugin(this.config));
			this.middlewareStack.use((0, import_dist_cjs$9.getUserAgentPlugin)(this.config));
			this.middlewareStack.use((0, import_dist_cjs$13.getRetryPlugin)(this.config));
			this.middlewareStack.use((0, import_dist_cjs$11.getContentLengthPlugin)(this.config));
			this.middlewareStack.use((0, import_dist_cjs$6.getHostHeaderPlugin)(this.config));
			this.middlewareStack.use((0, import_dist_cjs$7.getLoggerPlugin)(this.config));
			this.middlewareStack.use((0, import_dist_cjs$8.getRecursionDetectionPlugin)(this.config));
			this.middlewareStack.use(getHttpAuthSchemeEndpointRuleSetPlugin(this.config, {
				httpAuthSchemeParametersProvider: defaultSTSHttpAuthSchemeParametersProvider,
				identityProviderConfigProvider: async (config) => new DefaultIdentityProviderConfig({
					"aws.auth#sigv4": config.credentials,
					"aws.auth#sigv4a": config.credentials
				})
			}));
			this.middlewareStack.use(getHttpSigningPlugin(this.config));
		}
		destroy() {
			super.destroy();
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sts/commands/AssumeRoleCommand.js
var import_dist_cjs$4, import_dist_cjs$5, AssumeRoleCommand;
var init_AssumeRoleCommand = __esmMin((() => {
	import_dist_cjs$4 = require_dist_cjs$4();
	import_dist_cjs$5 = require_dist_cjs$22();
	init_EndpointParameters();
	init_schemas_0();
	AssumeRoleCommand = class extends import_dist_cjs$5.Command.classBuilder().ep(commonParams).m(function(Command, cs, config, o) {
		return [(0, import_dist_cjs$4.getEndpointPlugin)(config, Command.getEndpointParameterInstructions())];
	}).s("AWSSecurityTokenServiceV20110615", "AssumeRole", {}).n("STSClient", "AssumeRoleCommand").sc(AssumeRole$).build() {};
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sts/commands/AssumeRoleWithWebIdentityCommand.js
var import_dist_cjs$2, import_dist_cjs$3, AssumeRoleWithWebIdentityCommand;
var init_AssumeRoleWithWebIdentityCommand = __esmMin((() => {
	import_dist_cjs$2 = require_dist_cjs$4();
	import_dist_cjs$3 = require_dist_cjs$22();
	init_EndpointParameters();
	init_schemas_0();
	AssumeRoleWithWebIdentityCommand = class extends import_dist_cjs$3.Command.classBuilder().ep(commonParams).m(function(Command, cs, config, o) {
		return [(0, import_dist_cjs$2.getEndpointPlugin)(config, Command.getEndpointParameterInstructions())];
	}).s("AWSSecurityTokenServiceV20110615", "AssumeRoleWithWebIdentity", {}).n("STSClient", "AssumeRoleWithWebIdentityCommand").sc(AssumeRoleWithWebIdentity$).build() {};
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sts/STS.js
var import_dist_cjs$1, commands, STS;
var init_STS = __esmMin((() => {
	import_dist_cjs$1 = require_dist_cjs$22();
	init_AssumeRoleCommand();
	init_AssumeRoleWithWebIdentityCommand();
	init_STSClient();
	commands = {
		AssumeRoleCommand,
		AssumeRoleWithWebIdentityCommand
	};
	STS = class extends STSClient {};
	(0, import_dist_cjs$1.createAggregatedClient)(commands, STS);
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sts/commands/index.js
var init_commands = __esmMin((() => {
	init_AssumeRoleCommand();
	init_AssumeRoleWithWebIdentityCommand();
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sts/models/models_0.js
var init_models_0 = __esmMin((() => {}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sts/defaultStsRoleAssumers.js
var import_dist_cjs, getAccountIdFromAssumedRoleUser, resolveRegion, getDefaultRoleAssumer$1, getDefaultRoleAssumerWithWebIdentity$1, isH2;
var init_defaultStsRoleAssumers = __esmMin((() => {
	init_client();
	import_dist_cjs = require_dist_cjs$16();
	init_AssumeRoleCommand();
	init_AssumeRoleWithWebIdentityCommand();
	getAccountIdFromAssumedRoleUser = (assumedRoleUser) => {
		if (typeof assumedRoleUser?.Arn === "string") {
			const arnComponents = assumedRoleUser.Arn.split(":");
			if (arnComponents.length > 4 && arnComponents[4] !== "") return arnComponents[4];
		}
	};
	resolveRegion = async (_region, _parentRegion, credentialProviderLogger, loaderConfig = {}) => {
		const region = typeof _region === "function" ? await _region() : _region;
		const parentRegion = typeof _parentRegion === "function" ? await _parentRegion() : _parentRegion;
		let stsDefaultRegion = "";
		const resolvedRegion = region ?? parentRegion ?? (stsDefaultRegion = await (0, import_dist_cjs.stsRegionDefaultResolver)(loaderConfig)());
		credentialProviderLogger?.debug?.("@aws-sdk/client-sts::resolveRegion", "accepting first of:", `${region} (credential provider clientConfig)`, `${parentRegion} (contextual client)`, `${stsDefaultRegion} (STS default: AWS_REGION, profile region, or us-east-1)`);
		return resolvedRegion;
	};
	getDefaultRoleAssumer$1 = (stsOptions, STSClient) => {
		let stsClient;
		let closureSourceCreds;
		return async (sourceCreds, params) => {
			closureSourceCreds = sourceCreds;
			if (!stsClient) {
				const { logger = stsOptions?.parentClientConfig?.logger, profile = stsOptions?.parentClientConfig?.profile, region, requestHandler = stsOptions?.parentClientConfig?.requestHandler, credentialProviderLogger, userAgentAppId = stsOptions?.parentClientConfig?.userAgentAppId } = stsOptions;
				const resolvedRegion = await resolveRegion(region, stsOptions?.parentClientConfig?.region, credentialProviderLogger, {
					logger,
					profile
				});
				const isCompatibleRequestHandler = !isH2(requestHandler);
				stsClient = new STSClient({
					...stsOptions,
					userAgentAppId,
					profile,
					credentialDefaultProvider: () => async () => closureSourceCreds,
					region: resolvedRegion,
					requestHandler: isCompatibleRequestHandler ? requestHandler : void 0,
					logger
				});
			}
			const { Credentials, AssumedRoleUser } = await stsClient.send(new AssumeRoleCommand(params));
			if (!Credentials || !Credentials.AccessKeyId || !Credentials.SecretAccessKey) throw new Error(`Invalid response from STS.assumeRole call with role ${params.RoleArn}`);
			const accountId = getAccountIdFromAssumedRoleUser(AssumedRoleUser);
			const credentials = {
				accessKeyId: Credentials.AccessKeyId,
				secretAccessKey: Credentials.SecretAccessKey,
				sessionToken: Credentials.SessionToken,
				expiration: Credentials.Expiration,
				...Credentials.CredentialScope && { credentialScope: Credentials.CredentialScope },
				...accountId && { accountId }
			};
			setCredentialFeature(credentials, "CREDENTIALS_STS_ASSUME_ROLE", "i");
			return credentials;
		};
	};
	getDefaultRoleAssumerWithWebIdentity$1 = (stsOptions, STSClient) => {
		let stsClient;
		return async (params) => {
			if (!stsClient) {
				const { logger = stsOptions?.parentClientConfig?.logger, profile = stsOptions?.parentClientConfig?.profile, region, requestHandler = stsOptions?.parentClientConfig?.requestHandler, credentialProviderLogger, userAgentAppId = stsOptions?.parentClientConfig?.userAgentAppId } = stsOptions;
				const resolvedRegion = await resolveRegion(region, stsOptions?.parentClientConfig?.region, credentialProviderLogger, {
					logger,
					profile
				});
				const isCompatibleRequestHandler = !isH2(requestHandler);
				stsClient = new STSClient({
					...stsOptions,
					userAgentAppId,
					profile,
					region: resolvedRegion,
					requestHandler: isCompatibleRequestHandler ? requestHandler : void 0,
					logger
				});
			}
			const { Credentials, AssumedRoleUser } = await stsClient.send(new AssumeRoleWithWebIdentityCommand(params));
			if (!Credentials || !Credentials.AccessKeyId || !Credentials.SecretAccessKey) throw new Error(`Invalid response from STS.assumeRoleWithWebIdentity call with role ${params.RoleArn}`);
			const accountId = getAccountIdFromAssumedRoleUser(AssumedRoleUser);
			const credentials = {
				accessKeyId: Credentials.AccessKeyId,
				secretAccessKey: Credentials.SecretAccessKey,
				sessionToken: Credentials.SessionToken,
				expiration: Credentials.Expiration,
				...Credentials.CredentialScope && { credentialScope: Credentials.CredentialScope },
				...accountId && { accountId }
			};
			if (accountId) setCredentialFeature(credentials, "RESOLVED_ACCOUNT_ID", "T");
			setCredentialFeature(credentials, "CREDENTIALS_STS_ASSUME_ROLE_WEB_ID", "k");
			return credentials;
		};
	};
	isH2 = (requestHandler) => {
		return requestHandler?.metadata?.handlerProtocol === "h2";
	};
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sts/defaultRoleAssumers.js
var getCustomizableStsClientCtor, getDefaultRoleAssumer, getDefaultRoleAssumerWithWebIdentity, decorateDefaultCredentialProvider;
var init_defaultRoleAssumers = __esmMin((() => {
	init_defaultStsRoleAssumers();
	init_STSClient();
	getCustomizableStsClientCtor = (baseCtor, customizations) => {
		if (!customizations) return baseCtor;
		else return class CustomizableSTSClient extends baseCtor {
			constructor(config) {
				super(config);
				for (const customization of customizations) this.middlewareStack.use(customization);
			}
		};
	};
	getDefaultRoleAssumer = (stsOptions = {}, stsPlugins) => getDefaultRoleAssumer$1(stsOptions, getCustomizableStsClientCtor(STSClient, stsPlugins));
	getDefaultRoleAssumerWithWebIdentity = (stsOptions = {}, stsPlugins) => getDefaultRoleAssumerWithWebIdentity$1(stsOptions, getCustomizableStsClientCtor(STSClient, stsPlugins));
	decorateDefaultCredentialProvider = (provider) => (input) => provider({
		roleAssumer: getDefaultRoleAssumer(input),
		roleAssumerWithWebIdentity: getDefaultRoleAssumerWithWebIdentity(input),
		...input
	});
}));
//#endregion
//#region node_modules/@aws-sdk/nested-clients/dist-es/submodules/sts/index.js
var sts_exports = /* @__PURE__ */ __exportAll({
	AssumeRole$: () => AssumeRole$,
	AssumeRoleCommand: () => AssumeRoleCommand,
	AssumeRoleRequest$: () => AssumeRoleRequest$,
	AssumeRoleResponse$: () => AssumeRoleResponse$,
	AssumeRoleWithWebIdentity$: () => AssumeRoleWithWebIdentity$,
	AssumeRoleWithWebIdentityCommand: () => AssumeRoleWithWebIdentityCommand,
	AssumeRoleWithWebIdentityRequest$: () => AssumeRoleWithWebIdentityRequest$,
	AssumeRoleWithWebIdentityResponse$: () => AssumeRoleWithWebIdentityResponse$,
	AssumedRoleUser$: () => AssumedRoleUser$,
	Credentials$: () => Credentials$,
	ExpiredTokenException: () => ExpiredTokenException,
	ExpiredTokenException$: () => ExpiredTokenException$,
	IDPCommunicationErrorException: () => IDPCommunicationErrorException,
	IDPCommunicationErrorException$: () => IDPCommunicationErrorException$,
	IDPRejectedClaimException: () => IDPRejectedClaimException,
	IDPRejectedClaimException$: () => IDPRejectedClaimException$,
	InvalidIdentityTokenException: () => InvalidIdentityTokenException,
	InvalidIdentityTokenException$: () => InvalidIdentityTokenException$,
	MalformedPolicyDocumentException: () => MalformedPolicyDocumentException,
	MalformedPolicyDocumentException$: () => MalformedPolicyDocumentException$,
	PackedPolicyTooLargeException: () => PackedPolicyTooLargeException,
	PackedPolicyTooLargeException$: () => PackedPolicyTooLargeException$,
	PolicyDescriptorType$: () => PolicyDescriptorType$,
	ProvidedContext$: () => ProvidedContext$,
	RegionDisabledException: () => RegionDisabledException,
	RegionDisabledException$: () => RegionDisabledException$,
	STS: () => STS,
	STSClient: () => STSClient,
	STSServiceException: () => STSServiceException,
	STSServiceException$: () => STSServiceException$,
	Tag$: () => Tag$,
	__Client: () => import_dist_cjs$14.Client,
	decorateDefaultCredentialProvider: () => decorateDefaultCredentialProvider,
	errorTypeRegistries: () => errorTypeRegistries,
	getDefaultRoleAssumer: () => getDefaultRoleAssumer,
	getDefaultRoleAssumerWithWebIdentity: () => getDefaultRoleAssumerWithWebIdentity
});
var init_sts = __esmMin((() => {
	init_STSClient();
	init_STS();
	init_commands();
	init_schemas_0();
	init_errors();
	init_models_0();
	init_defaultRoleAssumers();
	init_STSServiceException();
}));
//#endregion
export { Tag$ as A, InvalidIdentityTokenException$ as C, ProvidedContext$ as D, PolicyDescriptorType$ as E, InvalidIdentityTokenException as F, MalformedPolicyDocumentException as I, PackedPolicyTooLargeException as L, ExpiredTokenException as M, IDPCommunicationErrorException as N, RegionDisabledException$ as O, IDPRejectedClaimException as P, RegionDisabledException as R, IDPRejectedClaimException$ as S, PackedPolicyTooLargeException$ as T, AssumeRoleWithWebIdentityResponse$ as _, getDefaultRoleAssumerWithWebIdentity as a, ExpiredTokenException$ as b, AssumeRoleCommand as c, import_dist_cjs$14 as d, AssumeRole$ as f, AssumeRoleWithWebIdentityRequest$ as g, AssumeRoleWithWebIdentity$ as h, getDefaultRoleAssumer as i, errorTypeRegistries as j, STSServiceException$ as k, import_dist_cjs$5 as l, AssumeRoleResponse$ as m, sts_exports as n, STS as o, AssumeRoleRequest$ as p, decorateDefaultCredentialProvider as r, AssumeRoleWithWebIdentityCommand as s, init_sts as t, STSClient as u, AssumedRoleUser$ as v, MalformedPolicyDocumentException$ as w, IDPCommunicationErrorException$ as x, Credentials$ as y, STSServiceException as z };
