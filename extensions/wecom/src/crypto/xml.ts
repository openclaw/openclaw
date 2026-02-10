/**
 * WeCom XML 加解密辅助函数
 * 用于 Agent 模式处理 XML 格式回调
 */

/**
 * 从 XML 密文中提取 Encrypt 字段
 */
export function extractEncryptFromXml(xml: string): string {
    const match = /<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>/s.exec(xml);
    if (!match?.[1]) {
        // 尝试不带 CDATA 的格式
        const altMatch = /<Encrypt>(.*?)<\/Encrypt>/s.exec(xml);
        if (!altMatch?.[1]) {
            throw new Error("Invalid XML: missing Encrypt field");
        }
        return altMatch[1];
    }
    return match[1];
}

/**
 * 从 XML 中提取 ToUserName (CorpID)
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
 * 构建加密 XML 响应
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
