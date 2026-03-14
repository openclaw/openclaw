import preferences from '@ohos.data.preferences';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { huks } from '@kit.UniversalKeystoreKit';

const PREFERENCES_NAME = 'openclaw_prefs';
const SECURE_PREFENCES_NAME = 'openclaw_secure_prefs';
const SECURE_PREFS_KEY_ALIAS = 'openclaw_secure_prefs_aes_gcm';
const SECURE_PREFS_AAD = 'openclaw.secure-prefs';
const SECURE_PREFS_NONCE_BYTES = 12;
const SECURE_PREFS_TAG_BYTES = 16;
const SECURE_PREFS_PREFIX = '__openclaw_huks_v1__:';

class SecureEnvelope {
  nonce: string = '';
  ciphertext: string = '';
}

// LocationMode type alias
export enum LocationMode {
  Off = 'off',
  Approximate = 'approximate',
  Precise = 'precise'
}

// Default location mode constant
const LOCATION_MODE_DEFAULT: string = 'off';

/**
 * Secure Preferences wrapper for HarmonyOS
 * Provides encrypted storage for sensitive data
 */
export class SecurePrefs {
  private static instance: SecurePrefs;
  private prefs: preferences.Preferences | null = null;
  private securePreferences: preferences.Preferences | null = null;
  private initialized: boolean = false;
  private initPromise: Promise<void> | null = null;
  private secureKeyReady: boolean = false;
  private secureKeyPromise: Promise<void> | null = null;

  private constructor() {}

  static getInstance(): SecurePrefs {
    if (!SecurePrefs.instance) {
      SecurePrefs.instance = new SecurePrefs();
    }
    return SecurePrefs.instance;
  }

  /**
   * Initialize preferences - must be called before use
   */
  async init(context: Context): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async (): Promise<void> => {
      try {
        this.prefs = await preferences.getPreferences(context, PREFERENCES_NAME);
        this.securePreferences = await preferences.getPreferences(context, SECURE_PREFENCES_NAME);

        // Initialize default values
        await this.initDefaults();
        this.initialized = true;
      } catch (error) {
        console.error('SecurePrefs init error:', error);
        throw new Error('SecurePrefs init failed');
      }
    })();

    return this.initPromise;
  }

  private async waitForInitialization(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.initPromise) {
      await this.initPromise;
    }
  }

  private async initDefaults(): Promise<void> {
    if (!this.prefs) {
      return;
    }

    const defaultKeys: string[] = [
      'instance_id',
      'display_name',
      'identity_created_at',
      'camera_enabled',
      'location_mode',
      'location_precise_enabled',
      'prevent_sleep',
      'talk_enabled',
      'speaker_enabled',
      'manual_enabled',
      'manual_host',
      'manual_port',
      'manual_tls',
      'onboarding_completed',
      'canvas_debug_status_enabled',
      'last_discovered_stable_id'
    ];

    const defaultValues: Record<string, preferences.ValueType> = {
      'instance_id': this.generateInstanceId(),
      'display_name': '',
      'identity_created_at': Date.now(),
      'camera_enabled': false,
      'location_mode': LOCATION_MODE_DEFAULT,
      'location_precise_enabled': false,
      'prevent_sleep': false,
      'talk_enabled': false,
      'speaker_enabled': false,
      'manual_enabled': false,
      'manual_host': '',
      'manual_port': 18789,
      'manual_tls': false,
      'onboarding_completed': false,
      'canvas_debug_status_enabled': false,
      'last_discovered_stable_id': ''
    };

    for (let i = 0; i < defaultKeys.length; i++) {
      const key = defaultKeys[i];
      const exists = await this.prefs.has(key);
      if (!exists) {
        await this.prefs.put(key, defaultValues[key]);
      }
    }

    await this.prefs.flush();
  }

  private generateInstanceId(): string {
    const randomBytes = cryptoFramework.createRandom().generateRandomSync(16).data;
    randomBytes[6] = (randomBytes[6] & 0x0f) | 0x40;
    randomBytes[8] = (randomBytes[8] & 0x3f) | 0x80;
    let hex = '';
    for (let i = 0; i < randomBytes.length; i++) {
      const value = randomBytes[i].toString(16);
      hex += value.length === 1 ? '0' + value : value;
    }
    return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}`;
  }

  async getInstanceId(): Promise<string> {
    return this.getString('instance_id', '');
  }

  async getIdentityCreatedAt(): Promise<number> {
    return this.getNumber('identity_created_at', 0);
  }

  async getDisplayName(): Promise<string> {
    return this.getString('display_name', '');
  }

  async setDisplayName(value: string): Promise<void> {
    await this.putString('display_name', value);
  }

  async getCameraEnabled(): Promise<boolean> {
    return this.getBoolean('camera_enabled', false);
  }

  async setCameraEnabled(value: boolean): Promise<void> {
    await this.putBoolean('camera_enabled', value);
  }

  async getLocationMode(): Promise<string> {
    return this.getString('location_mode', LOCATION_MODE_DEFAULT);
  }

  async setLocationMode(mode: LocationMode): Promise<void> {
    await this.putString('location_mode', mode);
  }

  async getLocationPreciseEnabled(): Promise<boolean> {
    return this.getBoolean('location_precise_enabled', false);
  }

  async setLocationPreciseEnabled(value: boolean): Promise<void> {
    await this.putBoolean('location_precise_enabled', value);
  }

  async getPreventSleep(): Promise<boolean> {
    return this.getBoolean('prevent_sleep', false);
  }

  async setPreventSleep(value: boolean): Promise<void> {
    await this.putBoolean('prevent_sleep', value);
  }

  async getTalkEnabled(): Promise<boolean> {
    return this.getBoolean('talk_enabled', false);
  }

  async setTalkEnabled(value: boolean): Promise<void> {
    await this.putBoolean('talk_enabled', value);
  }

  async getSpeakerEnabled(): Promise<boolean> {
    return this.getBoolean('speaker_enabled', false);
  }

  async setSpeakerEnabled(value: boolean): Promise<void> {
    await this.putBoolean('speaker_enabled', value);
  }

  async getManualEnabled(): Promise<boolean> {
    return this.getBoolean('manual_enabled', false);
  }

  async setManualEnabled(value: boolean): Promise<void> {
    await this.putBoolean('manual_enabled', value);
  }

  async getManualHost(): Promise<string> {
    return this.getString('manual_host', '');
  }

  async setManualHost(value: string): Promise<void> {
    await this.putString('manual_host', value);
  }

  async getManualPort(): Promise<number> {
    return this.getNumber('manual_port', 18789);
  }

  async setManualPort(value: number): Promise<void> {
    await this.putNumber('manual_port', value);
  }

  async getManualTls(): Promise<boolean> {
    return this.getBoolean('manual_tls', false);
  }

  async setManualTls(value: boolean): Promise<void> {
    await this.putBoolean('manual_tls', value);
  }

  async getGatewayToken(): Promise<string> {
    return this.getSecureString('gateway_token', '');
  }

  async setGatewayToken(value: string): Promise<void> {
    await this.putSecureString('gateway_token', value);
  }

  async getGatewayPassword(): Promise<string> {
    return this.getSecureString('gateway_password', '');
  }

  async setGatewayPassword(value: string): Promise<void> {
    await this.putSecureString('gateway_password', value);
  }

  async getOnboardingCompleted(): Promise<boolean> {
    return this.getBoolean('onboarding_completed', false);
  }

  async setOnboardingCompleted(value: boolean): Promise<void> {
    await this.putBoolean('onboarding_completed', value);
  }

  async getCanvasDebugStatusEnabled(): Promise<boolean> {
    return this.getBoolean('canvas_debug_status_enabled', false);
  }

  async setCanvasDebugStatusEnabled(value: boolean): Promise<void> {
    await this.putBoolean('canvas_debug_status_enabled', value);
  }

  async getLastDiscoveredStableId(): Promise<string> {
    return this.getString('last_discovered_stable_id', '');
  }

  async setLastDiscoveredStableId(value: string): Promise<void> {
    await this.putString('last_discovered_stable_id', value);
  }

  // Public accessors for secure storage (used by DeviceAuthStore)
  async getSecureStringPublic(key: string, defaultValue: string): Promise<string> {
    return this.getSecureString(key, defaultValue);
  }

  async putSecureStringPublic(key: string, value: string): Promise<void> {
    await this.putSecureString(key, value);
  }

  private async getString(key: string, defaultValue: string): Promise<string> {
    await this.waitForInitialization();
    if (!this.prefs) {
      return defaultValue;
    }
    try {
      const val = await this.prefs.get(key, defaultValue);
      return val as string;
    } catch {
      return defaultValue;
    }
  }

  private async putString(key: string, value: string): Promise<void> {
    await this.waitForInitialization();
    if (!this.prefs) {
      return;
    }
    await this.prefs.put(key, value);
    await this.prefs.flush();
  }

  private async getBoolean(key: string, defaultValue: boolean): Promise<boolean> {
    await this.waitForInitialization();
    if (!this.prefs) {
      return defaultValue;
    }
    try {
      const val = await this.prefs.get(key, defaultValue);
      return val as boolean;
    } catch {
      return defaultValue;
    }
  }

  private async putBoolean(key: string, value: boolean): Promise<void> {
    await this.waitForInitialization();
    if (!this.prefs) {
      return;
    }
    await this.prefs.put(key, value);
    await this.prefs.flush();
  }

  private async getNumber(key: string, defaultValue: number): Promise<number> {
    await this.waitForInitialization();
    if (!this.prefs) {
      return defaultValue;
    }
    try {
      const val = await this.prefs.get(key, defaultValue);
      return val as number;
    } catch {
      return defaultValue;
    }
  }

  private async putNumber(key: string, value: number): Promise<void> {
    await this.waitForInitialization();
    if (!this.prefs) {
      return;
    }
    await this.prefs.put(key, value);
    await this.prefs.flush();
  }

  private async getSecureString(key: string, defaultValue: string): Promise<string> {
    await this.waitForInitialization();
    if (!this.securePreferences) {
      return defaultValue;
    }
    try {
      const stored = await this.securePreferences.get(key, defaultValue);
      const encryptedStr = stored as string;
      if (encryptedStr === defaultValue || encryptedStr.length === 0) {
        return defaultValue;
      }

      if (!this.isEncryptedValue(encryptedStr)) {
        await this.putSecureString(key, encryptedStr);
        return encryptedStr;
      }

      const decrypted = await this.decryptSecureValue(encryptedStr);
      return decrypted !== null ? decrypted : defaultValue;
    } catch (error) {
      console.error('SecurePrefs getSecureString error:', error);
      return defaultValue;
    }
  }

  private async putSecureString(key: string, value: string): Promise<void> {
    await this.waitForInitialization();
    if (!this.securePreferences) {
      return;
    }
    const encryptedValue = value.length === 0 ? '' : await this.encryptSecureValue(value);
    await this.securePreferences.put(key, encryptedValue);
    await this.securePreferences.flush();
  }

  private async ensureSecureKey(): Promise<void> {
    if (this.secureKeyReady) {
      return;
    }
    if (this.secureKeyPromise) {
      return this.secureKeyPromise;
    }

    this.secureKeyPromise = (async (): Promise<void> => {
      const emptyOptions: huks.HuksOptions = {
        properties: []
      };
      const exists = await huks.hasKeyItem(SECURE_PREFS_KEY_ALIAS, emptyOptions);
      if (!exists) {
        const options: huks.HuksOptions = {
          properties: this.getAesGenerateProperties(),
          inData: new Uint8Array([])
        };
        await huks.generateKeyItem(SECURE_PREFS_KEY_ALIAS, options);
      }
      this.secureKeyReady = true;
    })();

    try {
      await this.secureKeyPromise;
    } finally {
      this.secureKeyPromise = null;
    }
  }

  private getAesGenerateProperties(): Array<huks.HuksParam> {
    return [{
      tag: huks.HuksTag.HUKS_TAG_ALGORITHM,
      value: huks.HuksKeyAlg.HUKS_ALG_AES
    }, {
      tag: huks.HuksTag.HUKS_TAG_KEY_SIZE,
      value: huks.HuksKeySize.HUKS_AES_KEY_SIZE_256
    }, {
      tag: huks.HuksTag.HUKS_TAG_PURPOSE,
      value: huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_ENCRYPT | huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_DECRYPT
    }];
  }

  private getAesEncryptProperties(nonce: Uint8Array): Array<huks.HuksParam> {
    return [{
      tag: huks.HuksTag.HUKS_TAG_ALGORITHM,
      value: huks.HuksKeyAlg.HUKS_ALG_AES
    }, {
      tag: huks.HuksTag.HUKS_TAG_KEY_SIZE,
      value: huks.HuksKeySize.HUKS_AES_KEY_SIZE_256
    }, {
      tag: huks.HuksTag.HUKS_TAG_PURPOSE,
      value: huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_ENCRYPT
    }, {
      tag: huks.HuksTag.HUKS_TAG_PADDING,
      value: huks.HuksKeyPadding.HUKS_PADDING_NONE
    }, {
      tag: huks.HuksTag.HUKS_TAG_BLOCK_MODE,
      value: huks.HuksCipherMode.HUKS_MODE_GCM
    }, {
      tag: huks.HuksTag.HUKS_TAG_NONCE,
      value: nonce
    }, {
      tag: huks.HuksTag.HUKS_TAG_ASSOCIATED_DATA,
      value: this.encodeUtf8(SECURE_PREFS_AAD)
    }];
  }

  private getAesDecryptProperties(cipherData: Uint8Array, nonce: Uint8Array): Array<huks.HuksParam> {
    return [{
      tag: huks.HuksTag.HUKS_TAG_ALGORITHM,
      value: huks.HuksKeyAlg.HUKS_ALG_AES
    }, {
      tag: huks.HuksTag.HUKS_TAG_KEY_SIZE,
      value: huks.HuksKeySize.HUKS_AES_KEY_SIZE_256
    }, {
      tag: huks.HuksTag.HUKS_TAG_PURPOSE,
      value: huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_DECRYPT
    }, {
      tag: huks.HuksTag.HUKS_TAG_PADDING,
      value: huks.HuksKeyPadding.HUKS_PADDING_NONE
    }, {
      tag: huks.HuksTag.HUKS_TAG_BLOCK_MODE,
      value: huks.HuksCipherMode.HUKS_MODE_GCM
    }, {
      tag: huks.HuksTag.HUKS_TAG_NONCE,
      value: nonce
    }, {
      tag: huks.HuksTag.HUKS_TAG_ASSOCIATED_DATA,
      value: this.encodeUtf8(SECURE_PREFS_AAD)
    }, {
      tag: huks.HuksTag.HUKS_TAG_AE_TAG,
      value: cipherData.slice(cipherData.length - SECURE_PREFS_TAG_BYTES)
    }];
  }

  private async encryptSecureValue(value: string): Promise<string> {
    await this.ensureSecureKey();
    const nonceBlob = cryptoFramework.createRandom().generateRandomSync(SECURE_PREFS_NONCE_BYTES);
    const nonce = nonceBlob.data;
    const initOptions: huks.HuksOptions = {
      properties: this.getAesEncryptProperties(nonce),
      inData: new Uint8Array([])
    };
    const finishOptions: huks.HuksOptions = {
      properties: this.getAesEncryptProperties(nonce),
      inData: this.encodeUtf8(value)
    };
    const initResult = await huks.initSession(SECURE_PREFS_KEY_ALIAS, initOptions);
    let finishResult: huks.HuksReturnResult;
    try {
      finishResult = await huks.finishSession(initResult.handle, finishOptions);
    } catch (error) {
      try {
        await huks.abortSession(initResult.handle, { properties: [] });
      } catch (_) {
      }
      throw error as Error;
    }
    const envelope = new SecureEnvelope();
    envelope.nonce = this.encodeBase64(nonce);
    envelope.ciphertext = this.encodeBase64((finishResult.outData as Uint8Array) || new Uint8Array([]));
    return SECURE_PREFS_PREFIX + JSON.stringify(envelope);
  }

  private async decryptSecureValue(value: string): Promise<string | null> {
    await this.ensureSecureKey();
    const rawEnvelope = value.slice(SECURE_PREFS_PREFIX.length);
    const envelope = JSON.parse(rawEnvelope) as SecureEnvelope;
    const nonce = new Uint8Array(this.decodeBase64(envelope.nonce));
    const cipherData = new Uint8Array(this.decodeBase64(envelope.ciphertext));
    if (cipherData.length < SECURE_PREFS_TAG_BYTES) {
      return null;
    }
    const initOptions: huks.HuksOptions = {
      properties: this.getAesDecryptProperties(cipherData, nonce),
      inData: new Uint8Array([])
    };
    const finishOptions: huks.HuksOptions = {
      properties: this.getAesDecryptProperties(cipherData, nonce),
      inData: cipherData.slice(0, cipherData.length - SECURE_PREFS_TAG_BYTES)
    };
    const initResult = await huks.initSession(SECURE_PREFS_KEY_ALIAS, initOptions);
    let finishResult: huks.HuksReturnResult;
    try {
      finishResult = await huks.finishSession(initResult.handle, finishOptions);
    } catch (e) {
      try {
        await huks.abortSession(initResult.handle, { properties: [] });
      } catch (_) {
      }
      throw e as Error;
    }
    const plainBytes = (finishResult.outData as Uint8Array) || new Uint8Array([]);
    return this.decodeUtf8(plainBytes);
  }

  private isEncryptedValue(value: string): boolean {
    return value.startsWith(SECURE_PREFS_PREFIX);
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

  private decodeUtf8(bytes: Uint8Array): string {
    let output = '';
    for (let i = 0; i < bytes.length; i++) {
      const byte0 = bytes[i];
      if (byte0 < 0x80) {
        output += String.fromCharCode(byte0);
        continue;
      }
      if ((byte0 & 0xe0) === 0xc0 && i + 1 < bytes.length) {
        const codePoint = ((byte0 & 0x1f) << 6) | (bytes[i + 1] & 0x3f);
        output += String.fromCharCode(codePoint);
        i += 1;
        continue;
      }
      if ((byte0 & 0xf0) === 0xe0 && i + 2 < bytes.length) {
        const codePoint = ((byte0 & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f);
        output += String.fromCharCode(codePoint);
        i += 2;
        continue;
      }
      if ((byte0 & 0xf8) === 0xf0 && i + 3 < bytes.length) {
        const codePoint = ((byte0 & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
        const adjusted = codePoint - 0x10000;
        output += String.fromCharCode(0xd800 | (adjusted >> 10));
        output += String.fromCharCode(0xdc00 | (adjusted & 0x3ff));
        i += 3;
      }
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
}

// Export singleton instance
export const securePrefs = SecurePrefs.getInstance();
