/**
 * WeCom 加解密模块导出
 */

// AES 加解密
export {
    decodeEncodingAESKey,
    pkcs7Unpad,
    decryptWecomEncrypted,
    encryptWecomPlaintext,
} from "./aes.js";

// 签名验证
export {
    computeWecomMsgSignature,
    verifyWecomSignature,
} from "./signature.js";

// XML 辅助
export {
    extractEncryptFromXml,
    extractToUserNameFromXml,
    buildEncryptedXmlResponse,
} from "./xml.js";
