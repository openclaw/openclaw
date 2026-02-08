{
"i18nArchitecture": {
"name": "OpenClaw i18n System",
"version": "1.0.0",
"description": "Internationalization architecture for OpenClaw TypeScript/Node.js CLI application",
"architecture": {
"type": "custom-lightweight",
"approach": "JSON-based namespace translation system",
"dependencies": {
"external": [],
"node": ["fs", "path"]
}
}
},

"directoryStructure": {
"src/i18n/": {
"description": "Main i18n module directory",
"files": [
{
"path": "src/i18n/index.ts",
"purpose": "Main entry point and public API exports"
},
{
"path": "src/i18n/config.ts",
"purpose": "Configuration constants and locale definitions"
},
{
"path": "src/i18n/types.ts",
"purpose": "TypeScript type definitions"
},
{
"path": "src/i18n/detector.ts",
"purpose": "Language detection from env vars, CLI args, system locale"
},
{
"path": "src/i18n/loader.ts",
"purpose": "Translation file loading and parsing"
},
{
"path": "src/i18n/translator.ts",
"purpose": "Core translation function and i18n instance"
},
{
"path": "src/i18n/ARCHITECTURE.md",
"purpose": "Architecture documentation and guide"
},
{
"path": "src/i18n/integration-example.ts",
"purpose": "Code examples for i18n integration"
},
{
"path": "src/i18n/i18n.test.ts",
"purpose": "Unit tests for i18n functionality"
}
],
"locales/": {
"description": "Translation files organized by locale code",
"files": [
{
"path": "src/i18n/locales/en.json",
"purpose": "English (US) translations - source language",
"strings": 120
},
{
"path": "src/i18n/locales/zh-CN.json",
"purpose": "Chinese (Simplified) translations",
"strings": 120
}
]
}
}
},

"translationFileFormat": {
"structure": "JSON with namespace organization",
"namespaces": {
"cli": {
"description": "CLI command descriptions and UI text",
"examples": ["help", "version", "status", "exit"]
},
"errors": {
"description": "Error messages shown to users",
"examples": ["fileNotFound", "permissionDenied", "networkError"]
},
"wizards": {
"description": "Setup wizard prompts and messages",
"examples": ["welcomeTitle", "selectLanguage", "scanQrCode"]
},
"status": {
"description": "System status and progress messages",
"examples": ["running", "connected", "loading"]
},
"validation": {
"description": "Form input validation messages",
"examples": ["emailInvalid", "minLength", "requiredField"]
},
"common": {
"description": "Frequently used UI strings",
"examples": ["yes", "no", "ok", "cancel", "save"]
}
},
"interpolation": {
"syntax": "{{placeholderName}}",
"description": "Mustache-style variable substitution",
"supportedTypes": ["string", "number", "boolean"],
"example": {
"key": "errors.fileNotFound",
"template": "File not found: {{file}}",
"call": "t('errors.fileNotFound', { file: 'config.json' })",
"result": "File not found: config.json"
}
}
},

"supportedLocales": [
{
"code": "en",
"name": "English",
"nativeName": "English",
"file": "en.json",
"status": "complete"
},
{
"code": "zh-CN",
"name": "Chinese (Simplified)",
"nativeName": "简体中文",
"file": "zh-CN.json",
"status": "complete"
},
{
"code": "zh-TW",
"name": "Chinese (Traditional)",
"nativeName": "繁體中文",
"file": "zh-TW.json",
"status": "pending"
}
],

"languageDetection": {
"priorityOrder": [
{
"source": "Environment Variable",
"variable": "OPENCLAW_LOCALE",
"example": "OPENCLAW_LOCALE=zh-CN pnpm openclaw"
},
{
"source": "CLI Flag",
"flag": "--lang <locale>",
"example": "pnpm openclaw --lang zh-CN status"
},
{
"source": "System Locale",
"variables": ["LC_ALL", "LC_MESSAGES", "LANG"],
"fallback": "Intl.DateTimeFormat().locale"
},
{
"source": "Default",
"fallbackTo": "en (English)"
}
]
},

"apiReference": {
"mainExports": [
{
"name": "createI18n",
"signature": "createI18n(locale?: SupportedLocale, options?: I18nConfig): Translator",
"description": "Create a new translator instance with specified locale",
"example": "const t = createI18n('zh-CN')"
},
{
"name": "t",
"signature": "t(key: string, params?: TranslationParams): string",
"description": "Translate a key with optional parameters",
"example": "t('errors.fileNotFound', { file: 'config.json' })"
},
{
"name": "setLocale",
"signature": "setLocale(locale: SupportedLocale): void",
"description": "Change the current locale globally",
"example": "setLocale('zh-CN')"
},
{
"name": "getLocale",
"signature": "getLocale(): SupportedLocale",
"description": "Get the current locale",
"example": "const current = getLocale()"
},
{
"name": "has",
"signature": "has(key: string): boolean",
"description": "Check if a translation key exists",
"example": "if (has('errors.notFound')) { ... }"
}
],
"types": [
{
"name": "SupportedLocale",
"values": ["en", "zh-CN", "zh-TW"]
},
{
"name": "TranslationParams",
"description": "Record<string, string | number | boolean>"
},
{
"name": "TranslationKey",
"format": "namespace.key (e.g., 'errors.fileNotFound')"
},
{
"name": "Translator",
"description": "Interface with methods: t(), setLocale(), getLocale(), has()"
}
]
},

"integrationPatterns": {
"simpleUsage": {
"description": "Use global t() function for quick integration",
"code": "t('errors.fileNotFound', { file: path })"
},
"classIntegration": {
"description": "Create dedicated translator instance for services",
"code": "this.translator = createI18n(getLocale())"
},
"cliCommands": {
"description": "Integrate with CLI command handlers",
"code": "if (options.lang) setLocale(options.lang)"
},
"wizardPrompts": {
"description": "Use with interactive prompts like @clack/prompts",
"code": "await select({ message: t('wizards.selectLanguage') })"
},
"errorHandling": {
"description": "Wrap errors with translated messages",
"code": "throw new AppError(t('errors.notFound', { item: 'config' }))"
},
"validation": {
"description": "Return translated validation messages",
"code": "errors.push(t('validation.emailInvalid'))"
}
},

"sampleTranslations": {
"english": {
"common": {
"yes": "Yes",
"no": "No",
"ok": "OK",
"cancel": "Cancel",
"save": "Save",
"delete": "Delete",
"error": "Error",
"success": "Success",
"loading": "Loading..."
},
"errors": {
"unknown": "An unknown error occurred",
"fileNotFound": "File not found: {{file}}",
"permissionDenied": "Permission denied",
"networkError": "Network error: {{reason}}",
"connectionFailed": "Connection failed"
},
"status": {
"running": "Running",
"stopped": "Stopped",
"connected": "Connected",
"disconnected": "Disconnected",
"loading": "Loading...",
"saving": "Saving..."
},
"wizards": {
"welcomeTitle": "Welcome to OpenClaw",
"welcomeMessage": "Let's get you set up in just a few steps",
"selectLanguage": "Select your language",
"scanQrCode": "Please scan this QR code with your phone"
},
"validation": {
"emailInvalid": "Please enter a valid email address",
"minLength": "Must be at least {{min}} characters",
"requiredField": "{{field}} is required"
}
},
"chinese": {
"common": {
"yes": "是",
"no": "否",
"ok": "确定",
"cancel": "取消",
"save": "保存",
"delete": "删除",
"error": "错误",
"success": "成功",
"loading": "加载中..."
},
"errors": {
"unknown": "发生未知错误",
"fileNotFound": "文件未找到: {{file}}",
"permissionDenied": "权限被拒绝",
"networkError": "网络错误: {{reason}}",
"connectionFailed": "连接失败"
},
"status": {
"running": "运行中",
"stopped": "已停止",
"connected": "已连接",
"disconnected": "已断开",
"loading": "加载中...",
"saving": "保存中..."
},
"wizards": {
"welcomeTitle": "欢迎使用 OpenClaw",
"welcomeMessage": "只需几步即可完成设置",
"selectLanguage": "选择语言",
"scanQrCode": "请使用手机扫描此二维码"
},
"validation": {
"emailInvalid": "请输入有效的电子邮件地址",
"minLength": "至少需要{{min}}个字符",
"requiredField": "{{field}}为必填项"
}
}
},

"contributionGuide": {
"file": "CONTRIBUTING_I18N.md",
"sections": [
"Overview",
"Getting Started",
"Translation Workflow",
"File Structure",
"Translation Guidelines",
"Adding a New Language",
"Testing Translations",
"Best Practices",
"Tools and Resources"
]
},

"nextSteps": [
"Verify TypeScript compilation with 'pnpm build'",
"Run tests with 'pnpm test src/i18n/i18n.test.ts'",
"Integrate t() calls into existing CLI code",
"Add more locales (ja, ko, de, fr, es)",
"Add pluralization support for complex languages",
"Implement translation validation tooling"
],

"filesCreated": [
"src/i18n/index.ts",
"src/i18n/config.ts",
"src/i18n/types.ts",
"src/i18n/detector.ts",
"src/i18n/loader.ts",
"src/i18n/translator.ts",
"src/i18n/ARCHITECTURE.md",
"src/i18n/integration-example.ts",
"src/i18n/i18n.test.ts",
"src/i18n/locales/en.json",
"src/i18n/locales/zh-CN.json",
"CONTRIBUTING_I18N.md",
"docs/i18n/README.md"
]
}
