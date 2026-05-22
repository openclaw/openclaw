import { t as __commonJSMin } from "./chunk-CNf5ZN-e.js";
import { m as require_dist_cjs$1 } from "./httpAuthSchemes-0G32ph_d.js";
//#region node_modules/@aws-sdk/signature-v4-multi-region/dist-cjs/index.js
var require_dist_cjs = /* @__PURE__ */ __commonJSMin(((exports) => {
	var signatureV4 = require_dist_cjs$1();
	const signatureV4CrtContainer = { CrtSignerV4: null };
	const SESSION_TOKEN_QUERY_PARAM = "X-Amz-S3session-Token";
	const SESSION_TOKEN_HEADER = SESSION_TOKEN_QUERY_PARAM.toLowerCase();
	var SignatureV4SignWithCredentials = class extends signatureV4.SignatureV4 {
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
		const currentCredentialProvider = privateAccess.credentialProvider;
		privateAccess.credentialProvider = () => {
			privateAccess.credentialProvider = currentCredentialProvider;
			return Promise.resolve(credentialsWithoutSessionToken);
		};
	}
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
			this.sigv4Signer = new SignatureV4SignWithCredentials(options);
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
	exports.SignatureV4SignWithCredentials = SignatureV4SignWithCredentials;
	exports.signatureV4CrtContainer = signatureV4CrtContainer;
}));
//#endregion
export { require_dist_cjs as t };
