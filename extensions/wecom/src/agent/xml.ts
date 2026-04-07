/**
 * WeCom XML Encryption/Decryption Helper Functions
 * Used for processing XML format callbacks in Agent mode
 */

/**
 * Extract the Encrypt field from XML ciphertext
 */
export function extractEncryptFromXml(xml: string): string {
  const match = /<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>/s.exec(xml);
  if (!match?.[1]) {
    // Try format without CDATA
    const altMatch = /<Encrypt>(.*?)<\/Encrypt>/s.exec(xml);
    if (!altMatch?.[1]) {
      throw new Error("Invalid XML: missing Encrypt field");
    }
    return altMatch[1];
  }
  return match[1];
}

/**
 * Extract ToUserName (CorpID) from XML
 */
export function extractToUserNameFromXml(xml: string): string {
  const match = /<ToUserName><!\[CDATA\[(.*?)\]\]><\/ToUserName>/s.exec(xml);
  if (!match?.[1]) {
    const altMatch = /<ToUserName>(.*?)<\/ToUserName>/s.exec(xml);
    return altMatch?.[1] ?? "";
  }
  return match[1];
}

/**
 * Build encrypted XML response
 */
export function buildEncryptedXmlResponse(params: {
  encrypt: string;
  signature: string;
  timestamp: string;
  nonce: string;
}): string {
  return `<xml>
<Encrypt><![CDATA[${params.encrypt}]]></Encrypt>
<MsgSignature><![CDATA[${params.signature}]]></MsgSignature>
<TimeStamp>${params.timestamp}</TimeStamp>
<Nonce><![CDATA[${params.nonce}]]></Nonce>
</xml>`;
}
