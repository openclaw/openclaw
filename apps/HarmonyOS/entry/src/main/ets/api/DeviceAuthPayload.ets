export class DeviceAuthPayload {
  static buildV3(
    deviceId: string,
    clientId: string,
    clientMode: string,
    role: string,
    scopes: string[],
    signedAtMs: number,
    token?: string,
    nonce?: string,
    platform?: string,
    deviceFamily?: string
  ): string {
    const scopeString = scopes.join(',');
    const authToken = token ? token.replace(/\|/g, '') : '';
    const nonceStr = nonce ? nonce.replace(/\|/g, '') : '';
    const platformNorm = DeviceAuthPayload.normalizeMetadataField(platform);
    const deviceFamilyNorm = DeviceAuthPayload.normalizeMetadataField(deviceFamily);

    return [
      'v3',
      deviceId,
      clientId,
      clientMode,
      role,
      scopeString,
      signedAtMs.toString(),
      authToken,
      nonceStr,
      platformNorm,
      deviceFamilyNorm
    ].join('|');
  }

  static normalizeMetadataField(value?: string): string {
    const trimmed = value ? value.trim() : '';
    if (trimmed.length === 0) {
      return '';
    }

    let out = '';
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed.charAt(i);
      if (ch === '|') {
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code >= 65 && code <= 90) {
        out += String.fromCharCode(code + 32);
      } else {
        out += ch;
      }
    }
    return out;
  }
}