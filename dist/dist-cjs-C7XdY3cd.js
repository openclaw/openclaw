import { a as __toCommonJS, i as __require, t as __commonJSMin } from "./chunk-HkwdBwDg.js";
import { D as schema_exports, E as init_schema } from "./protocols-CO3NMy6S.js";
import { t as require_dist_cjs$3 } from "./dist-cjs-DQR3Meck.js";
import { n as client_exports, r as init_client } from "./dist-cjs-DS9W42km.js";
import { A as require_dist_cjs$4, C as dist_es_exports, M as protocols_exports, j as init_protocols, k as require_dist_cjs$5, w as init_dist_es, z as require_dist_cjs$6 } from "./dist-cjs-D0pP6SUX.js";
import { n as require_dist_cjs$7 } from "./dist-cjs-DDGLQYvl.js";
//#region node_modules/@aws-sdk/middleware-sdk-s3/dist-cjs/toStream.js
var require_toStream = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.toStream = toStream;
	const node_stream_1 = __require("node:stream");
	function toStream(bytes) {
		return node_stream_1.Readable.from(Buffer.from(bytes));
	}
}));
//#endregion
//#region node_modules/@aws-sdk/util-arn-parser/dist-cjs/index.js
var require_dist_cjs$2 = /* @__PURE__ */ __commonJSMin(((exports) => {
	const validate = (str) => typeof str === "string" && str.indexOf("arn:") === 0 && str.split(":").length >= 6;
	const parse = (arn) => {
		const segments = arn.split(":");
		if (segments.length < 6 || segments[0] !== "arn") throw new Error("Malformed ARN");
		const [, partition, service, region, accountId, ...resource] = segments;
		return {
			partition,
			service,
			region,
			accountId,
			resource: resource.join(":")
		};
	};
	const build = (arnObject) => {
		const { partition = "aws", service, region, accountId, resource } = arnObject;
		if ([
			service,
			region,
			accountId,
			resource
		].some((segment) => typeof segment !== "string")) throw new Error("Input ARN object is invalid");
		return `arn:${partition}:${service}:${region}:${accountId}:${resource}`;
	};
	exports.build = build;
	exports.parse = parse;
	exports.validate = validate;
}));
//#endregion
//#region node_modules/@aws-sdk/middleware-sdk-s3/dist-cjs/index.js
var require_dist_cjs$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var protocolHttp = require_dist_cjs$3();
	var smithyClient = require_dist_cjs$7();
	var toStream = require_toStream();
	var utilArnParser = require_dist_cjs$2();
	var protocols = (init_protocols(), __toCommonJS(protocols_exports));
	var schema = (init_schema(), __toCommonJS(schema_exports));
	var signatureV4 = require_dist_cjs$4();
	var utilConfigProvider = require_dist_cjs$5();
	var client = (init_client(), __toCommonJS(client_exports));
	var core = (init_dist_es(), __toCommonJS(dist_es_exports));
	var utilMiddleware = require_dist_cjs$6();
	const CONTENT_LENGTH_HEADER = "content-length";
	const DECODED_CONTENT_LENGTH_HEADER = "x-amz-decoded-content-length";
	function checkContentLengthHeader() {
		return (next, context) => async (args) => {
			const { request } = args;
			if (protocolHttp.HttpRequest.isInstance(request)) {
				if (!(CONTENT_LENGTH_HEADER in request.headers) && !(DECODED_CONTENT_LENGTH_HEADER in request.headers)) {
					const message = `Are you using a Stream of unknown length as the Body of a PutObject request? Consider using Upload instead from @aws-sdk/lib-storage.`;
					if (typeof context?.logger?.warn === "function" && !(context.logger instanceof smithyClient.NoOpLogger)) context.logger.warn(message);
					else console.warn(message);
				}
			}
			return next({ ...args });
		};
	}
	const checkContentLengthHeaderMiddlewareOptions = {
		step: "finalizeRequest",
		tags: ["CHECK_CONTENT_LENGTH_HEADER"],
		name: "getCheckContentLengthHeaderPlugin",
		override: true
	};
	const getCheckContentLengthHeaderPlugin = (unused) => ({ applyToStack: (clientStack) => {
		clientStack.add(checkContentLengthHeader(), checkContentLengthHeaderMiddlewareOptions);
	} });
	const regionRedirectEndpointMiddleware = (config) => {
		return (next, context) => async (args) => {
			const originalRegion = await config.region();
			const regionProviderRef = config.region;
			let unlock = () => {};
			if (context.__s3RegionRedirect) {
				Object.defineProperty(config, "region", {
					writable: false,
					value: async () => {
						return context.__s3RegionRedirect;
					}
				});
				unlock = () => Object.defineProperty(config, "region", {
					writable: true,
					value: regionProviderRef
				});
			}
			try {
				const result = await next(args);
				if (context.__s3RegionRedirect) {
					unlock();
					if (originalRegion !== await config.region()) throw new Error("Region was not restored following S3 region redirect.");
				}
				return result;
			} catch (e) {
				unlock();
				throw e;
			}
		};
	};
	const regionRedirectEndpointMiddlewareOptions = {
		tags: ["REGION_REDIRECT", "S3"],
		name: "regionRedirectEndpointMiddleware",
		override: true,
		relation: "before",
		toMiddleware: "endpointV2Middleware"
	};
	function regionRedirectMiddleware(clientConfig) {
		return (next, context) => async (args) => {
			try {
				return await next(args);
			} catch (err) {
				if (clientConfig.followRegionRedirects) {
					const statusCode = err?.$metadata?.httpStatusCode;
					const isHeadBucket = context.commandName === "HeadBucketCommand";
					const bucketRegionHeader = err?.$response?.headers?.["x-amz-bucket-region"];
					if (bucketRegionHeader) {
						if (statusCode === 301 || statusCode === 400 && (err?.name === "IllegalLocationConstraintException" || isHeadBucket)) {
							try {
								const actualRegion = bucketRegionHeader;
								context.logger?.debug(`Redirecting from ${await clientConfig.region()} to ${actualRegion}`);
								context.__s3RegionRedirect = actualRegion;
							} catch (e) {
								throw new Error("Region redirect failed: " + e);
							}
							return next(args);
						}
					}
				}
				throw err;
			}
		};
	}
	const regionRedirectMiddlewareOptions = {
		step: "initialize",
		tags: ["REGION_REDIRECT", "S3"],
		name: "regionRedirectMiddleware",
		override: true
	};
	const getRegionRedirectMiddlewarePlugin = (clientConfig) => ({ applyToStack: (clientStack) => {
		clientStack.add(regionRedirectMiddleware(clientConfig), regionRedirectMiddlewareOptions);
		clientStack.addRelativeTo(regionRedirectEndpointMiddleware(clientConfig), regionRedirectEndpointMiddlewareOptions);
	} });
	const s3ExpiresMiddleware = (config) => {
		return (next, context) => async (args) => {
			const result = await next(args);
			const { response } = result;
			if (protocolHttp.HttpResponse.isInstance(response)) {
				if (response.headers.expires) {
					response.headers.expiresstring = response.headers.expires;
					try {
						smithyClient.parseRfc7231DateTime(response.headers.expires);
					} catch (e) {
						context.logger?.warn(`AWS SDK Warning for ${context.clientName}::${context.commandName} response parsing (${response.headers.expires}): ${e}`);
						delete response.headers.expires;
					}
				}
			}
			return result;
		};
	};
	const s3ExpiresMiddlewareOptions = {
		tags: ["S3"],
		name: "s3ExpiresMiddleware",
		override: true,
		relation: "after",
		toMiddleware: "deserializerMiddleware"
	};
	const getS3ExpiresMiddlewarePlugin = (clientConfig) => ({ applyToStack: (clientStack) => {
		clientStack.addRelativeTo(s3ExpiresMiddleware(), s3ExpiresMiddlewareOptions);
	} });
	var S3ExpressIdentityCache = class S3ExpressIdentityCache {
		data;
		lastPurgeTime = Date.now();
		static EXPIRED_CREDENTIAL_PURGE_INTERVAL_MS = 3e4;
		constructor(data = {}) {
			this.data = data;
		}
		get(key) {
			const entry = this.data[key];
			if (!entry) return;
			return entry;
		}
		set(key, entry) {
			this.data[key] = entry;
			return entry;
		}
		delete(key) {
			delete this.data[key];
		}
		async purgeExpired() {
			const now = Date.now();
			if (this.lastPurgeTime + S3ExpressIdentityCache.EXPIRED_CREDENTIAL_PURGE_INTERVAL_MS > now) return;
			for (const key in this.data) {
				const entry = this.data[key];
				if (!entry.isRefreshing) {
					const credential = await entry.identity;
					if (credential.expiration) {
						if (credential.expiration.getTime() < now) delete this.data[key];
					}
				}
			}
		}
	};
	var S3ExpressIdentityCacheEntry = class {
		_identity;
		isRefreshing;
		accessed;
		constructor(_identity, isRefreshing = false, accessed = Date.now()) {
			this._identity = _identity;
			this.isRefreshing = isRefreshing;
			this.accessed = accessed;
		}
		get identity() {
			this.accessed = Date.now();
			return this._identity;
		}
	};
	var S3ExpressIdentityProviderImpl = class S3ExpressIdentityProviderImpl {
		createSessionFn;
		cache;
		static REFRESH_WINDOW_MS = 6e4;
		constructor(createSessionFn, cache = new S3ExpressIdentityCache()) {
			this.createSessionFn = createSessionFn;
			this.cache = cache;
		}
		async getS3ExpressIdentity(awsIdentity, identityProperties) {
			const key = identityProperties.Bucket;
			const { cache } = this;
			const entry = cache.get(key);
			if (entry) return entry.identity.then((identity) => {
				if ((identity.expiration?.getTime() ?? 0) < Date.now()) return cache.set(key, new S3ExpressIdentityCacheEntry(this.getIdentity(key))).identity;
				if ((identity.expiration?.getTime() ?? 0) < Date.now() + S3ExpressIdentityProviderImpl.REFRESH_WINDOW_MS && !entry.isRefreshing) {
					entry.isRefreshing = true;
					this.getIdentity(key).then((id) => {
						cache.set(key, new S3ExpressIdentityCacheEntry(Promise.resolve(id)));
					});
				}
				return identity;
			});
			return cache.set(key, new S3ExpressIdentityCacheEntry(this.getIdentity(key))).identity;
		}
		async getIdentity(key) {
			await this.cache.purgeExpired().catch((error) => {
				console.warn("Error while clearing expired entries in S3ExpressIdentityCache: \n" + error);
			});
			const session = await this.createSessionFn(key);
			if (!session.Credentials?.AccessKeyId || !session.Credentials?.SecretAccessKey) throw new Error("s3#createSession response credential missing AccessKeyId or SecretAccessKey.");
			return {
				accessKeyId: session.Credentials.AccessKeyId,
				secretAccessKey: session.Credentials.SecretAccessKey,
				sessionToken: session.Credentials.SessionToken,
				expiration: session.Credentials.Expiration ? new Date(session.Credentials.Expiration) : void 0
			};
		}
	};
	const S3_EXPRESS_BUCKET_TYPE = "Directory";
	const S3_EXPRESS_BACKEND = "S3Express";
	const S3_EXPRESS_AUTH_SCHEME = "sigv4-s3express";
	const SESSION_TOKEN_QUERY_PARAM = "X-Amz-S3session-Token";
	const SESSION_TOKEN_HEADER = SESSION_TOKEN_QUERY_PARAM.toLowerCase();
	const NODE_DISABLE_S3_EXPRESS_SESSION_AUTH_ENV_NAME = "AWS_S3_DISABLE_EXPRESS_SESSION_AUTH";
	const NODE_DISABLE_S3_EXPRESS_SESSION_AUTH_INI_NAME = "s3_disable_express_session_auth";
	const NODE_DISABLE_S3_EXPRESS_SESSION_AUTH_OPTIONS = {
		environmentVariableSelector: (env) => utilConfigProvider.booleanSelector(env, NODE_DISABLE_S3_EXPRESS_SESSION_AUTH_ENV_NAME, utilConfigProvider.SelectorType.ENV),
		configFileSelector: (profile) => utilConfigProvider.booleanSelector(profile, NODE_DISABLE_S3_EXPRESS_SESSION_AUTH_INI_NAME, utilConfigProvider.SelectorType.CONFIG),
		default: false
	};
	var SignatureV4S3Express = class extends signatureV4.SignatureV4 {
		async signWithCredentials(requestToSign, credentials, options) {
			const credentialsWithoutSessionToken = getCredentialsWithoutSessionToken(credentials);
			requestToSign.headers[SESSION_TOKEN_HEADER] = credentials.sessionToken;
			const privateAccess = this;
			setSingleOverride(privateAccess, credentialsWithoutSessionToken);
			return privateAccess.signRequest(requestToSign, options ?? {});
		}
		async presignWithCredentials(requestToSign, credentials, options) {
			const credentialsWithoutSessionToken = getCredentialsWithoutSessionToken(credentials);
			delete requestToSign.headers[SESSION_TOKEN_HEADER];
			requestToSign.headers[SESSION_TOKEN_QUERY_PARAM] = credentials.sessionToken;
			requestToSign.query = requestToSign.query ?? {};
			requestToSign.query[SESSION_TOKEN_QUERY_PARAM] = credentials.sessionToken;
			setSingleOverride(this, credentialsWithoutSessionToken);
			return this.presign(requestToSign, options);
		}
	};
	function getCredentialsWithoutSessionToken(credentials) {
		return {
			accessKeyId: credentials.accessKeyId,
			secretAccessKey: credentials.secretAccessKey,
			expiration: credentials.expiration
		};
	}
	function setSingleOverride(privateAccess, credentialsWithoutSessionToken) {
		const id = setTimeout(() => {
			throw new Error("SignatureV4S3Express credential override was created but not called.");
		}, 10);
		const currentCredentialProvider = privateAccess.credentialProvider;
		const overrideCredentialsProviderOnce = () => {
			clearTimeout(id);
			privateAccess.credentialProvider = currentCredentialProvider;
			return Promise.resolve(credentialsWithoutSessionToken);
		};
		privateAccess.credentialProvider = overrideCredentialsProviderOnce;
	}
	const s3ExpressMiddleware = (options) => {
		return (next, context) => async (args) => {
			if (context.endpointV2) {
				const endpoint = context.endpointV2;
				const isS3ExpressAuth = endpoint.properties?.authSchemes?.[0]?.name === S3_EXPRESS_AUTH_SCHEME;
				if (endpoint.properties?.backend === S3_EXPRESS_BACKEND || endpoint.properties?.bucketType === S3_EXPRESS_BUCKET_TYPE) {
					client.setFeature(context, "S3_EXPRESS_BUCKET", "J");
					context.isS3ExpressBucket = true;
				}
				if (isS3ExpressAuth) {
					const requestBucket = args.input.Bucket;
					if (requestBucket) {
						const s3ExpressIdentity = await options.s3ExpressIdentityProvider.getS3ExpressIdentity(await options.credentials(), { Bucket: requestBucket });
						context.s3ExpressIdentity = s3ExpressIdentity;
						if (protocolHttp.HttpRequest.isInstance(args.request) && s3ExpressIdentity.sessionToken) args.request.headers[SESSION_TOKEN_HEADER] = s3ExpressIdentity.sessionToken;
					}
				}
			}
			return next(args);
		};
	};
	const s3ExpressMiddlewareOptions = {
		name: "s3ExpressMiddleware",
		step: "build",
		tags: ["S3", "S3_EXPRESS"],
		override: true
	};
	const getS3ExpressPlugin = (options) => ({ applyToStack: (clientStack) => {
		clientStack.add(s3ExpressMiddleware(options), s3ExpressMiddlewareOptions);
	} });
	const signS3Express = async (s3ExpressIdentity, signingOptions, request, sigV4MultiRegionSigner) => {
		const signedRequest = await sigV4MultiRegionSigner.signWithCredentials(request, s3ExpressIdentity, {});
		if (signedRequest.headers["X-Amz-Security-Token"] || signedRequest.headers["x-amz-security-token"]) throw new Error("X-Amz-Security-Token must not be set for s3-express requests.");
		return signedRequest;
	};
	const defaultErrorHandler = (signingProperties) => (error) => {
		throw error;
	};
	const defaultSuccessHandler = (httpResponse, signingProperties) => {};
	const s3ExpressHttpSigningMiddlewareOptions = core.httpSigningMiddlewareOptions;
	const s3ExpressHttpSigningMiddleware = (config) => (next, context) => async (args) => {
		if (!protocolHttp.HttpRequest.isInstance(args.request)) return next(args);
		const scheme = utilMiddleware.getSmithyContext(context).selectedHttpAuthScheme;
		if (!scheme) throw new Error(`No HttpAuthScheme was selected: unable to sign request`);
		const { httpAuthOption: { signingProperties = {} }, identity, signer } = scheme;
		let request;
		if (context.s3ExpressIdentity) request = await signS3Express(context.s3ExpressIdentity, signingProperties, args.request, await config.signer());
		else request = await signer.sign(args.request, identity, signingProperties);
		const output = await next({
			...args,
			request
		}).catch((signer.errorHandler || defaultErrorHandler)(signingProperties));
		(signer.successHandler || defaultSuccessHandler)(output.response, signingProperties);
		return output;
	};
	const getS3ExpressHttpSigningPlugin = (config) => ({ applyToStack: (clientStack) => {
		clientStack.addRelativeTo(s3ExpressHttpSigningMiddleware(config), core.httpSigningMiddlewareOptions);
	} });
	const resolveS3Config = (input, { session }) => {
		const [s3ClientProvider, CreateSessionCommandCtor] = session;
		const { forcePathStyle, useAccelerateEndpoint, disableMultiregionAccessPoints, followRegionRedirects, s3ExpressIdentityProvider, bucketEndpoint, expectContinueHeader } = input;
		return Object.assign(input, {
			forcePathStyle: forcePathStyle ?? false,
			useAccelerateEndpoint: useAccelerateEndpoint ?? false,
			disableMultiregionAccessPoints: disableMultiregionAccessPoints ?? false,
			followRegionRedirects: followRegionRedirects ?? false,
			s3ExpressIdentityProvider: s3ExpressIdentityProvider ?? new S3ExpressIdentityProviderImpl(async (key) => s3ClientProvider().send(new CreateSessionCommandCtor({ Bucket: key }))),
			bucketEndpoint: bucketEndpoint ?? false,
			expectContinueHeader: expectContinueHeader ?? 2097152
		});
	};
	const THROW_IF_EMPTY_BODY = {
		CopyObjectCommand: true,
		UploadPartCopyCommand: true,
		CompleteMultipartUploadCommand: true
	};
	const throw200ExceptionsMiddleware = (config) => (next, context) => async (args) => {
		const result = await next(args);
		const { response } = result;
		if (!protocolHttp.HttpResponse.isInstance(response)) return result;
		const { statusCode, body } = response;
		if (statusCode < 200 || statusCode >= 300) return result;
		const bodyBytes = await collectBody(body, config);
		response.body = toStream.toStream(bodyBytes);
		if (bodyBytes.length === 0 && THROW_IF_EMPTY_BODY[context.commandName]) {
			const err = /* @__PURE__ */ new Error("S3 aborted request");
			err.$metadata = { httpStatusCode: 503 };
			err.name = "InternalError";
			throw err;
		}
		const bodyStringTail = config.utf8Encoder(bodyBytes.subarray(bodyBytes.length - 16));
		if (bodyStringTail && bodyStringTail.endsWith("</Error>")) response.statusCode = 503;
		return result;
	};
	const collectBody = (streamBody = new Uint8Array(), context) => {
		if (streamBody instanceof Uint8Array) return Promise.resolve(streamBody);
		return context.streamCollector(streamBody) || Promise.resolve(new Uint8Array());
	};
	const throw200ExceptionsMiddlewareOptions = {
		relation: "after",
		toMiddleware: "deserializerMiddleware",
		tags: ["THROW_200_EXCEPTIONS", "S3"],
		name: "throw200ExceptionsMiddleware",
		override: true
	};
	const getThrow200ExceptionsPlugin = (config) => ({ applyToStack: (clientStack) => {
		clientStack.addRelativeTo(throw200ExceptionsMiddleware(config), throw200ExceptionsMiddlewareOptions);
	} });
	function bucketEndpointMiddleware(options) {
		return (next, context) => async (args) => {
			if (options.bucketEndpoint) {
				const endpoint = context.endpointV2;
				if (endpoint) {
					const bucket = args.input.Bucket;
					if (typeof bucket === "string") try {
						const bucketEndpointUrl = new URL(bucket);
						context.endpointV2 = {
							...endpoint,
							url: bucketEndpointUrl
						};
					} catch (e) {
						const warning = `@aws-sdk/middleware-sdk-s3: bucketEndpoint=true was set but Bucket=${bucket} could not be parsed as URL.`;
						if (context.logger?.constructor?.name === "NoOpLogger") console.warn(warning);
						else context.logger?.warn?.(warning);
						throw e;
					}
				}
			}
			return next(args);
		};
	}
	const bucketEndpointMiddlewareOptions = {
		name: "bucketEndpointMiddleware",
		override: true,
		relation: "after",
		toMiddleware: "endpointV2Middleware"
	};
	function validateBucketNameMiddleware({ bucketEndpoint }) {
		return (next) => async (args) => {
			const { input: { Bucket } } = args;
			if (!bucketEndpoint && typeof Bucket === "string" && !utilArnParser.validate(Bucket) && Bucket.indexOf("/") >= 0) {
				const err = /* @__PURE__ */ new Error(`Bucket name shouldn't contain '/', received '${Bucket}'`);
				err.name = "InvalidBucketName";
				throw err;
			}
			return next({ ...args });
		};
	}
	const validateBucketNameMiddlewareOptions = {
		step: "initialize",
		tags: ["VALIDATE_BUCKET_NAME"],
		name: "validateBucketNameMiddleware",
		override: true
	};
	const getValidateBucketNamePlugin = (options) => ({ applyToStack: (clientStack) => {
		clientStack.add(validateBucketNameMiddleware(options), validateBucketNameMiddlewareOptions);
		clientStack.addRelativeTo(bucketEndpointMiddleware(options), bucketEndpointMiddlewareOptions);
	} });
	var S3RestXmlProtocol = class extends protocols.AwsRestXmlProtocol {
		async serializeRequest(operationSchema, input, context) {
			const request = await super.serializeRequest(operationSchema, input, context);
			const ns = schema.NormalizedSchema.of(operationSchema.input);
			const staticStructureSchema = ns.getSchema();
			let bucketMemberIndex = 0;
			const requiredMemberCount = staticStructureSchema[6] ?? 0;
			if (input && typeof input === "object") for (const [memberName, memberNs] of ns.structIterator()) {
				if (++bucketMemberIndex > requiredMemberCount) break;
				if (memberName === "Bucket") {
					if (!input.Bucket && memberNs.getMergedTraits().httpLabel) throw new Error(`No value provided for input HTTP label: Bucket.`);
					break;
				}
			}
			return request;
		}
	};
	exports.NODE_DISABLE_S3_EXPRESS_SESSION_AUTH_OPTIONS = NODE_DISABLE_S3_EXPRESS_SESSION_AUTH_OPTIONS;
	exports.S3ExpressIdentityCache = S3ExpressIdentityCache;
	exports.S3ExpressIdentityCacheEntry = S3ExpressIdentityCacheEntry;
	exports.S3ExpressIdentityProviderImpl = S3ExpressIdentityProviderImpl;
	exports.S3RestXmlProtocol = S3RestXmlProtocol;
	exports.SignatureV4S3Express = SignatureV4S3Express;
	exports.checkContentLengthHeader = checkContentLengthHeader;
	exports.checkContentLengthHeaderMiddlewareOptions = checkContentLengthHeaderMiddlewareOptions;
	exports.getCheckContentLengthHeaderPlugin = getCheckContentLengthHeaderPlugin;
	exports.getRegionRedirectMiddlewarePlugin = getRegionRedirectMiddlewarePlugin;
	exports.getS3ExpiresMiddlewarePlugin = getS3ExpiresMiddlewarePlugin;
	exports.getS3ExpressHttpSigningPlugin = getS3ExpressHttpSigningPlugin;
	exports.getS3ExpressPlugin = getS3ExpressPlugin;
	exports.getThrow200ExceptionsPlugin = getThrow200ExceptionsPlugin;
	exports.getValidateBucketNamePlugin = getValidateBucketNamePlugin;
	exports.regionRedirectEndpointMiddleware = regionRedirectEndpointMiddleware;
	exports.regionRedirectEndpointMiddlewareOptions = regionRedirectEndpointMiddlewareOptions;
	exports.regionRedirectMiddleware = regionRedirectMiddleware;
	exports.regionRedirectMiddlewareOptions = regionRedirectMiddlewareOptions;
	exports.resolveS3Config = resolveS3Config;
	exports.s3ExpiresMiddleware = s3ExpiresMiddleware;
	exports.s3ExpiresMiddlewareOptions = s3ExpiresMiddlewareOptions;
	exports.s3ExpressHttpSigningMiddleware = s3ExpressHttpSigningMiddleware;
	exports.s3ExpressHttpSigningMiddlewareOptions = s3ExpressHttpSigningMiddlewareOptions;
	exports.s3ExpressMiddleware = s3ExpressMiddleware;
	exports.s3ExpressMiddlewareOptions = s3ExpressMiddlewareOptions;
	exports.throw200ExceptionsMiddleware = throw200ExceptionsMiddleware;
	exports.throw200ExceptionsMiddlewareOptions = throw200ExceptionsMiddlewareOptions;
	exports.validateBucketNameMiddleware = validateBucketNameMiddleware;
	exports.validateBucketNameMiddlewareOptions = validateBucketNameMiddlewareOptions;
}));
//#endregion
//#region node_modules/@aws-sdk/signature-v4-multi-region/dist-cjs/index.js
var require_dist_cjs = /* @__PURE__ */ __commonJSMin(((exports) => {
	var middlewareSdkS3 = require_dist_cjs$1();
	var signatureV4 = require_dist_cjs$4();
	const signatureV4CrtContainer = { CrtSignerV4: null };
	var SignatureV4MultiRegion = class {
		sigv4aSigner;
		sigv4Signer;
		signerOptions;
		static sigv4aDependency() {
			if (typeof signatureV4CrtContainer.CrtSignerV4 === "function") return "crt";
			else if (typeof signatureV4.signatureV4aContainer.SignatureV4a === "function") return "js";
			return "none";
		}
		constructor(options) {
			this.sigv4Signer = new middlewareSdkS3.SignatureV4S3Express(options);
			this.signerOptions = options;
		}
		async sign(requestToSign, options = {}) {
			if (options.signingRegion === "*") return this.getSigv4aSigner().sign(requestToSign, options);
			return this.sigv4Signer.sign(requestToSign, options);
		}
		async signWithCredentials(requestToSign, credentials, options = {}) {
			if (options.signingRegion === "*") {
				const signer = this.getSigv4aSigner();
				const CrtSignerV4 = signatureV4CrtContainer.CrtSignerV4;
				if (CrtSignerV4 && signer instanceof CrtSignerV4) return signer.signWithCredentials(requestToSign, credentials, options);
				else throw new Error("signWithCredentials with signingRegion '*' is only supported when using the CRT dependency @aws-sdk/signature-v4-crt. Please check whether you have installed the \"@aws-sdk/signature-v4-crt\" package explicitly. You must also register the package by calling [require(\"@aws-sdk/signature-v4-crt\");] or an ESM equivalent such as [import \"@aws-sdk/signature-v4-crt\";]. For more information please go to https://github.com/aws/aws-sdk-js-v3#functionality-requiring-aws-common-runtime-crt");
			}
			return this.sigv4Signer.signWithCredentials(requestToSign, credentials, options);
		}
		async presign(originalRequest, options = {}) {
			if (options.signingRegion === "*") {
				const signer = this.getSigv4aSigner();
				const CrtSignerV4 = signatureV4CrtContainer.CrtSignerV4;
				if (CrtSignerV4 && signer instanceof CrtSignerV4) return signer.presign(originalRequest, options);
				else throw new Error("presign with signingRegion '*' is only supported when using the CRT dependency @aws-sdk/signature-v4-crt. Please check whether you have installed the \"@aws-sdk/signature-v4-crt\" package explicitly. You must also register the package by calling [require(\"@aws-sdk/signature-v4-crt\");] or an ESM equivalent such as [import \"@aws-sdk/signature-v4-crt\";]. For more information please go to https://github.com/aws/aws-sdk-js-v3#functionality-requiring-aws-common-runtime-crt");
			}
			return this.sigv4Signer.presign(originalRequest, options);
		}
		async presignWithCredentials(originalRequest, credentials, options = {}) {
			if (options.signingRegion === "*") throw new Error("Method presignWithCredentials is not supported for [signingRegion=*].");
			return this.sigv4Signer.presignWithCredentials(originalRequest, credentials, options);
		}
		getSigv4aSigner() {
			if (!this.sigv4aSigner) {
				const CrtSignerV4 = signatureV4CrtContainer.CrtSignerV4;
				const JsSigV4aSigner = signatureV4.signatureV4aContainer.SignatureV4a;
				if (this.signerOptions.runtime === "node") {
					if (!CrtSignerV4 && !JsSigV4aSigner) throw new Error("Neither CRT nor JS SigV4a implementation is available. Please load either @aws-sdk/signature-v4-crt or @aws-sdk/signature-v4a. For more information please go to https://github.com/aws/aws-sdk-js-v3#functionality-requiring-aws-common-runtime-crt");
					if (CrtSignerV4 && typeof CrtSignerV4 === "function") this.sigv4aSigner = new CrtSignerV4({
						...this.signerOptions,
						signingAlgorithm: 1
					});
					else if (JsSigV4aSigner && typeof JsSigV4aSigner === "function") this.sigv4aSigner = new JsSigV4aSigner({ ...this.signerOptions });
					else throw new Error("Available SigV4a implementation is not a valid constructor. Please ensure you've properly imported @aws-sdk/signature-v4-crt or @aws-sdk/signature-v4a.For more information please go to https://github.com/aws/aws-sdk-js-v3#functionality-requiring-aws-common-runtime-crt");
				} else {
					if (!JsSigV4aSigner || typeof JsSigV4aSigner !== "function") throw new Error("JS SigV4a implementation is not available or not a valid constructor. Please check whether you have installed the @aws-sdk/signature-v4a package explicitly. The CRT implementation is not available for browsers. You must also register the package by calling [require('@aws-sdk/signature-v4a');] or an ESM equivalent such as [import '@aws-sdk/signature-v4a';]. For more information please go to https://github.com/aws/aws-sdk-js-v3#using-javascript-non-crt-implementation-of-sigv4a");
					this.sigv4aSigner = new JsSigV4aSigner({ ...this.signerOptions });
				}
			}
			return this.sigv4aSigner;
		}
	};
	exports.SignatureV4MultiRegion = SignatureV4MultiRegion;
	exports.signatureV4CrtContainer = signatureV4CrtContainer;
}));
//#endregion
export { require_dist_cjs$1 as n, require_dist_cjs$2 as r, require_dist_cjs as t };
