import { E as pathExists } from "./fs-safe-CV86zY9G.js";
import { h as shortenHomeInString, p as resolveUserPath, s as ensureDir, t as CONFIG_DIR } from "./utils-sBTEdeml.js";
import { t as resolveSystemBin } from "./resolve-system-bin-pDkUnF3W.js";
import { t as normalizeFingerprint } from "./fingerprint-COSQ5VlL.js";
import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { promisify } from "node:util";
//#region src/infra/tls/gateway.ts
const execFileAsync = promisify(execFile);
async function generateSelfSignedCert(params) {
	const certDir = path.dirname(params.certPath);
	const keyDir = path.dirname(params.keyPath);
	await ensureDir(certDir);
	if (keyDir !== certDir) await ensureDir(keyDir);
	const opensslBin = resolveSystemBin("openssl");
	if (!opensslBin) throw new Error("openssl not found in trusted system directories. Install it in an OS-managed location.");
	await execFileAsync(opensslBin, [
		"req",
		"-x509",
		"-newkey",
		"rsa:2048",
		"-sha256",
		"-days",
		"3650",
		"-nodes",
		"-keyout",
		params.keyPath,
		"-out",
		params.certPath,
		"-subj",
		"/CN=openclaw-gateway"
	]);
	await fs.chmod(params.keyPath, 384).catch(() => {});
	await fs.chmod(params.certPath, 384).catch(() => {});
	params.log?.info?.(`gateway tls: generated self-signed cert at ${shortenHomeInString(params.certPath)}`);
}
async function loadGatewayTlsRuntime(cfg, log) {
	if (!cfg || cfg.enabled !== true) return {
		enabled: false,
		required: false
	};
	const autoGenerate = cfg.autoGenerate !== false;
	const baseDir = path.join(CONFIG_DIR, "gateway", "tls");
	const certPath = resolveUserPath(cfg.certPath ?? path.join(baseDir, "gateway-cert.pem"));
	const keyPath = resolveUserPath(cfg.keyPath ?? path.join(baseDir, "gateway-key.pem"));
	const caPath = cfg.caPath ? resolveUserPath(cfg.caPath) : void 0;
	const hasCert = await pathExists(certPath);
	const hasKey = await pathExists(keyPath);
	if (!hasCert && !hasKey && autoGenerate) try {
		await generateSelfSignedCert({
			certPath,
			keyPath,
			log
		});
	} catch (err) {
		return {
			enabled: false,
			required: true,
			certPath,
			keyPath,
			error: `gateway tls: failed to generate cert (${String(err)})`
		};
	}
	if (!await pathExists(certPath) || !await pathExists(keyPath)) return {
		enabled: false,
		required: true,
		certPath,
		keyPath,
		error: "gateway tls: cert/key missing"
	};
	try {
		const cert = await fs.readFile(certPath, "utf8");
		const key = await fs.readFile(keyPath, "utf8");
		const ca = caPath ? await fs.readFile(caPath, "utf8") : void 0;
		const fingerprintSha256 = normalizeFingerprint(new X509Certificate(cert).fingerprint256 ?? "");
		if (!fingerprintSha256) return {
			enabled: false,
			required: true,
			certPath,
			keyPath,
			caPath,
			error: "gateway tls: unable to compute certificate fingerprint"
		};
		return {
			enabled: true,
			required: true,
			certPath,
			keyPath,
			caPath,
			fingerprintSha256,
			tlsOptions: {
				cert,
				key,
				ca,
				minVersion: "TLSv1.3"
			}
		};
	} catch (err) {
		return {
			enabled: false,
			required: true,
			certPath,
			keyPath,
			caPath,
			error: `gateway tls: failed to load cert (${String(err)})`
		};
	}
}
//#endregion
export { loadGatewayTlsRuntime as t };
