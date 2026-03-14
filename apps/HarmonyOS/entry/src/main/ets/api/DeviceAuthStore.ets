import cryptoFramework from '@ohos.security.cryptoFramework';
import { securePrefs } from '../common/SecurePrefs';

/**
 * Device Auth data structure
 */
export interface DeviceAuth {
  deviceId: string;
  publicKey: string;
  privateKey: string;
  certificate?: string;
}

/**
 * Device Auth Store for HarmonyOS
 * Handles device authentication credentials
 */
export class DeviceAuthStore {
  private static instance: DeviceAuthStore;
  private readonly ed25519AlgorithmCandidates: string[] = ['Ed25519', 'ED25519', 'ECC25519', 'ECC25519|ED25519'];
  private readonly keyFormatMarker: string = 'ed25519-raw-le-v1';

  private constructor() {}

  static getInstance(): DeviceAuthStore {
    if (!DeviceAuthStore.instance) {
      DeviceAuthStore.instance = new DeviceAuthStore();
    }
    return DeviceAuthStore.instance;
  }

  /**
   * Get device auth from storage
   */
  async getDeviceAuth(): Promise<DeviceAuth | null> {
    try {
      const authJson = await securePrefs.getSecureStringPublic('device_auth', '');
      if (!authJson) {
        return null;
      }
      const auth = JSON.parse(authJson) as DeviceAuth;
      if ((auth.certificate || '') !== this.keyFormatMarker) {
        console.warn('DeviceAuthStore: Stored device auth uses legacy key encoding, regenerating');
        return await this.generateDeviceAuth();
      }
      if (!this.hasExpectedKeyMaterial(auth)) {
        console.warn('DeviceAuthStore: Stored device auth is not Ed25519 raw key material, regenerating');
        return await this.generateDeviceAuth();
      }
      const derivedDeviceId = this.deriveDeviceIdFromPublicKey(auth.publicKey);
      if (derivedDeviceId.length > 0 && auth.deviceId !== derivedDeviceId) {
        const migrated: DeviceAuth = {
          deviceId: derivedDeviceId,
          publicKey: auth.publicKey,
          privateKey: auth.privateKey,
          certificate: auth.certificate
        };
        await this.saveDeviceAuth(migrated);
        return migrated;
      }
      return auth;
    } catch (error) {
      console.error('DeviceAuthStore: Get auth error:', error);
      return null;
    }
  }

  /**
   * Save device auth to storage
   */
  async saveDeviceAuth(auth: DeviceAuth): Promise<void> {
    try {
      const authJson = JSON.stringify(auth);
      await securePrefs.putSecureStringPublic('device_auth', authJson);
    } catch (error) {
      console.error('DeviceAuthStore: Save auth error:', error);
      throw new Error('Failed to save device auth');
    }
  }

  /**
   * Generate new device auth
   */
  async generateDeviceAuth(): Promise<DeviceAuth> {
    try {
      const keyPair = await this.generateKeyPair();
      const deviceId = this.deriveDeviceIdFromPublicKey(keyPair.publicKey);

      const auth: DeviceAuth = {
        deviceId,
        publicKey: keyPair.publicKey,
        privateKey: keyPair.privateKey,
        certificate: this.keyFormatMarker
      };

      await this.saveDeviceAuth(auth);

      return auth;
    } catch (error) {
      console.error('DeviceAuthStore: Generate auth error:', error);
      throw new Error('Failed to generate device auth');
    }
  }

  /**
   * Get instance ID (delegates to securePrefs)
   */
  async getInstanceId(): Promise<string> {
    return securePrefs.getInstanceId();
  }

  /**
   * Get display name (delegates to securePrefs)
   */
  async getDisplayName(): Promise<string> {
    return securePrefs.getDisplayName();
  }

  /**
   * Sign payload with stored Ed25519 private key
   */
  async signPayload(payload: string, auth: DeviceAuth): Promise<string | null> {
    const privateKeyBytes = new Uint8Array(this.decodeBase64(auth.privateKey));
    if (privateKeyBytes.length !== 32) {
      console.error('DeviceAuthStore: signPayload invalid private key length=' + privateKeyBytes.length);
      return null;
    }

    const payloadBlob: cryptoFramework.DataBlob = {
      data: this.encodeUtf8(payload)
    };

    for (let i = 0; i < this.ed25519AlgorithmCandidates.length; i++) {
      const algName = this.ed25519AlgorithmCandidates[i];
      try {
        const priSpec: cryptoFramework.ED25519PriKeySpec = {
          algName,
          specType: cryptoFramework.AsyKeySpecType.PRIVATE_KEY_SPEC,
          sk: this.bytesToBigIntLE(privateKeyBytes)
        };
        const keyGenerator = cryptoFramework.createAsyKeyGeneratorBySpec(priSpec);
        const priKey = await keyGenerator.generatePriKey();
        const signer = cryptoFramework.createSign(algName);
        await signer.init(priKey);
        const signatureBlob = await signer.sign(payloadBlob);
        console.info('DeviceAuthStore: signPayload succeeded with alg=' + algName);
        return this.encodeBase64Url(signatureBlob.data);
      } catch (error) {
        console.warn('DeviceAuthStore: signPayload candidate failed, alg=' + algName + ', error=' + error);
      }
    }

    console.error('DeviceAuthStore: signPayload failed for all Ed25519 candidates');
    return null;
  }

  /**
   * Generate Ed25519 key pair
   */
  private async generateKeyPair(): Promise<KeyPairResult> {
    for (let i = 0; i < this.ed25519AlgorithmCandidates.length; i++) {
      const algName = this.ed25519AlgorithmCandidates[i];
      try {
        const keyGenerator = cryptoFramework.createAsyKeyGenerator(algName);
        const keyPair = await keyGenerator.generateKeyPair();
        const publicKey = this.encodeBase64(
          this.bigIntToFixedBytesLE(
            keyPair.pubKey.getAsyKeySpec(cryptoFramework.AsyKeySpecItem.ED25519_PK_BN) as bigint,
            32
          )
        );
        const privateKey = this.encodeBase64(
          this.bigIntToFixedBytesLE(
            keyPair.priKey.getAsyKeySpec(cryptoFramework.AsyKeySpecItem.ED25519_SK_BN) as bigint,
            32
          )
        );
        console.info('DeviceAuthStore: generateKeyPair succeeded with alg=' + algName);
        const result: KeyPairResult = { publicKey, privateKey };
        return result;
      } catch (error) {
        console.warn('DeviceAuthStore: Key generation candidate failed, alg=' + algName + ', error=' + error);
      }
    }

    throw new Error('Failed to generate key pair');
  }

  private hasExpectedKeyMaterial(auth: DeviceAuth): boolean {
    return this.decodeBase64(auth.publicKey).length === 32 && this.decodeBase64(auth.privateKey).length === 32;
  }

  private encodeUtf8(value: string): Uint8Array {
    const bytes: number[] = [];
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);

      if (code < 0x80) {
        bytes.push(code);
        continue;
      }

      if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6));
        bytes.push(0x80 | (code & 0x3f));
        continue;
      }

      if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
        const low = value.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          const codePoint = 0x10000 + (((code & 0x3ff) << 10) | (low & 0x3ff));
          bytes.push(0xf0 | (codePoint >> 18));
          bytes.push(0x80 | ((codePoint >> 12) & 0x3f));
          bytes.push(0x80 | ((codePoint >> 6) & 0x3f));
          bytes.push(0x80 | (codePoint & 0x3f));
          i += 1;
          continue;
        }
      }

      bytes.push(0xe0 | (code >> 12));
      bytes.push(0x80 | ((code >> 6) & 0x3f));
      bytes.push(0x80 | (code & 0x3f));
    }
    return new Uint8Array(bytes);
  }

  private bytesToBigIntLE(bytes: Uint8Array): bigint {
    let hex = '0x';
    for (let i = bytes.length - 1; i >= 0; i--) {
      const value = bytes[i];
      hex += (value < 16 ? '0' : '') + value.toString(16);
    }
    return BigInt(hex);
  }

  private bigIntToFixedBytesLE(value: bigint, length: number): Uint8Array {
    let hex = value.toString(16);
    if (hex.length % 2 !== 0) {
      hex = '0' + hex;
    }
    const targetHexLength = length * 2;
    if (hex.length < targetHexLength) {
      hex = '0'.repeat(targetHexLength - hex.length) + hex;
    }
    if (hex.length > targetHexLength) {
      hex = hex.slice(hex.length - targetHexLength);
    }

    const output = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      output[length - 1 - i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return output;
  }

  private encodeBase64(bytes: Uint8Array): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let output = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const byte0 = bytes[i];
      const byte1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
      const byte2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
      const combined = (byte0 << 16) | (byte1 << 8) | byte2;

      output += alphabet.charAt((combined >> 18) & 0x3f);
      output += alphabet.charAt((combined >> 12) & 0x3f);
      output += i + 1 < bytes.length ? alphabet.charAt((combined >> 6) & 0x3f) : '=';
      output += i + 2 < bytes.length ? alphabet.charAt(combined & 0x3f) : '=';
    }
    return output;
  }

  private encodeBase64Url(bytes: Uint8Array): string {
    return this.encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  private deriveDeviceIdFromPublicKey(publicKey: string): string {
    const decoded = this.decodeBase64(publicKey);
    if (decoded.length === 0) {
      return '';
    }
    const digest = cryptoFramework.createMd('SHA256');
    digest.updateSync({ data: new Uint8Array(decoded) });
    return this.bytesToHex(digest.digestSync().data);
  }

  private decodeBase64(input: string): number[] {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const sanitized = input.trim();
    const output: number[] = [];
    let buffer = 0;
    let bits = 0;

    for (let i = 0; i < sanitized.length; i++) {
      const ch = sanitized.charAt(i);
      if (ch === '=') {
        break;
      }
      const value = alphabet.indexOf(ch);
      if (value < 0) {
        continue;
      }
      buffer = (buffer << 6) | value;
      bits += 6;
      while (bits >= 8) {
        bits -= 8;
        output.push((buffer >> bits) & 0xff);
      }
    }

    return output;
  }

  private bytesToHex(bytes: Uint8Array): string {
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
      const value = bytes[i];
      hex += (value < 16 ? '0' : '') + value.toString(16);
    }
    return hex;
  }
}

interface KeyPairResult {
  publicKey: string;
  privateKey: string;
}

export const deviceAuthStore = DeviceAuthStore.getInstance();
