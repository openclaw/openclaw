// 安全修复：输入验证辅助函数
// 为OpenClaw项目添加增强的输入验证功能

/**
 * 安全输入验证辅助函数
 * 防止常见的安全漏洞如XSS、SQL注入、命令注入等
 */

/**
 * 验证URL输入，防止SSRF和其他URL相关攻击
 */
export function validateSafeUrl(url: string): string | null {
  if (!url || typeof url !== 'string') {
    return null;
  }
  
  try {
    const parsed = new URL(url);
    
    // 检查协议是否安全
    const safeProtocols = ['http:', 'https:', 'ws:', 'wss:'];
    if (!safeProtocols.includes(parsed.protocol)) {
      console.warn(`Security warning: Unsafe protocol ${parsed.protocol} in URL`);
      return null;
    }
    
    // 检查是否为内部地址（防止SSRF）
    const internalHosts = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];
    if (internalHosts.includes(parsed.hostname)) {
      console.warn('Security warning: Attempt to access internal address');
      return null;
    }
    
    // 检查是否为私有IP地址
    const isPrivateIP = (hostname: string) => {
      return hostname.startsWith('10.') ||
             hostname.startsWith('192.168.') ||
             hostname.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./) ||
             hostname === 'localhost';
    };
    
    if (isPrivateIP(parsed.hostname)) {
      console.warn('Security warning: Attempt to access private IP address');
      return null;
    }
    
    return url;
  } catch (error) {
    console.warn('Security warning: Invalid URL format');
    return null;
  }
}

/**
 * 验证和清理字符串输入，防止XSS
 */
export function sanitizeStringInput(input: unknown, maxLength = 1000): string {
  if (input === null || input === undefined) {
    return '';
  }
  
  const str = String(input);
  
  // 限制长度防止DoS
  if (str.length > maxLength) {
    console.warn(`Security warning: Input too long (${str.length} > ${maxLength})`);
    return str.substring(0, maxLength);
  }
  
  // 移除危险字符（基础XSS防护）
  let sanitized = str
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
  
  // 移除控制字符
  sanitized = sanitized.replace(/[\x00-\x1F\x7F]/g, '');
  
  return sanitized;
}

/**
 * 验证数字输入
 */
export function validateNumber(input: unknown, min?: number, max?: number): number | null {
  if (input === null || input === undefined) {
    return null;
  }
  
  const num = Number(input);
  if (isNaN(num) || !isFinite(num)) {
    console.warn('Security warning: Invalid number input');
    return null;
  }
  
  if (min !== undefined && num < min) {
    console.warn(`Security warning: Number below minimum (${num} < ${min})`);
    return null;
  }
  
  if (max !== undefined && num > max) {
    console.warn(`Security warning: Number above maximum (${num} > ${max})`);
    return null;
  }
  
  return num;
}

/**
 * 验证JSON输入，防止原型污染和其他JSON相关攻击
 */
export function validateSafeJson(input: string): any {
  try {
    const parsed = JSON.parse(input);
    
    // 检查是否包含危险键名（原型污染防护）
    const dangerousKeys = ['__proto__', 'constructor', 'prototype'];
    const checkObject = (obj: any, path: string = ''): boolean => {
      if (obj && typeof obj === 'object') {
        for (const key in obj) {
          const fullPath = path ? `${path}.${key}` : key;
          
          // 检查危险键名
          if (dangerousKeys.includes(key)) {
            console.warn(`Security warning: Dangerous key in JSON: ${fullPath}`);
            return false;
          }
          
          // 递归检查嵌套对象
          if (!checkObject(obj[key], fullPath)) {
            return false;
          }
        }
      }
      return true;
    };
    
    if (!checkObject(parsed)) {
      throw new Error('Dangerous content in JSON');
    }
    
    return parsed;
  } catch (error) {
    console.warn('Security warning: Invalid or dangerous JSON input');
    throw error;
  }
}

/**
 * 验证文件路径输入，防止路径遍历攻击
 */
export function validateSafePath(input: string, baseDir?: string): string | null {
  if (!input || typeof input !== 'string') {
    return null;
  }
  
  // 移除空字符和危险字符
  let path = input.replace(/\0/g, '').trim();
  
  // 防止路径遍历攻击
  if (path.includes('..') || path.includes('//') || path.includes('\\')) {
    console.warn('Security warning: Path traversal attempt detected');
    return null;
  }
  
  // 如果指定了基础目录，确保路径在基础目录内
  if (baseDir) {
    const fullPath = require('path').resolve(baseDir, path);
    const normalizedBase = require('path').resolve(baseDir);
    
    if (!fullPath.startsWith(normalizedBase)) {
      console.warn('Security warning: Attempt to access outside base directory');
      return null;
    }
    
    path = fullPath;
  }
  
  return path;
}

/**
 * 验证API密钥格式
 */
export function validateApiKeyFormat(key: string): boolean {
  if (!key || typeof key !== 'string') {
    return false;
  }
  
  // 检查常见API密钥格式
  const apiKeyPatterns = [
    /^sk-[a-zA-Z0-9]{20,}$/,      // OpenAI格式
    /^pk-[a-zA-Z0-9]{20,}$/,      // OpenAI公钥格式
    /^gh[pousr]_[a-zA-Z0-9_]{36,}$/, // GitHub token格式
    /^xox[bp]-[a-zA-Z0-9-]+$/,    // Slack token格式
    /^[a-zA-Z0-9]{24}$/,          // MongoDB格式
    /^[a-f0-9]{32}$/,             // MD5哈希格式
    /^[a-f0-9]{40}$/,             // SHA-1格式
    /^[a-f0-9]{64}$/,             // SHA-256格式
  ];
  
  return apiKeyPatterns.some(pattern => pattern.test(key));
}

/**
 * 安全日志记录（避免记录敏感信息）
 */
export function safeLog(message: string, data?: any): void {
  const sensitivePatterns = [
    /password=.*/i,
    /secret=.*/i,
    /token=.*/i,
    /key=.*/i,
    /auth=.*/i,
    /["']?[a-f0-9]{32,}["']?/i, // 哈希值
  ];
  
  let safeMessage = message;
  sensitivePatterns.forEach(pattern => {
    safeMessage = safeMessage.replace(pattern, '[REDACTED]');
  });
  
  console.log(safeMessage);
  
  if (data) {
    // 深度清理数据中的敏感信息
    const cleanData = JSON.parse(JSON.stringify(data, (key, value) => {
      const lowerKey = key.toLowerCase();
      if (lowerKey.includes('pass') || 
          lowerKey.includes('secret') || 
          lowerKey.includes('token') || 
          lowerKey.includes('key') || 
          lowerKey.includes('auth')) {
        return '[REDACTED]';
      }
      
      // 检查值是否为可能的密钥
      if (typeof value === 'string' && validateApiKeyFormat(value)) {
        return '[REDACTED]';
      }
      
      return value;
    }));
    
    console.log('Data:', cleanData);
  }
}

// 导出所有安全函数
export default {
  validateSafeUrl,
  sanitizeStringInput,
  validateNumber,
  validateSafeJson,
  validateSafePath,
  validateApiKeyFormat,
  safeLog,
};