/**
 * File utilities for chat attachments
 */

// Accepted file types
export const ACCEPTED_FILE_TYPES = {
  images: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
  videos: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo'],
  archives: [
    'application/zip',
    'application/x-zip-compressed',
    'application/x-7z-compressed',
    'application/x-rar-compressed',
    'application/gzip',
    'application/x-tar',
  ],
  documents: ['application/pdf'],
  code: [
    'text/javascript',
    'application/javascript',
    'text/typescript',
    'application/typescript',
    'text/x-python',
    'text/x-java',
    'text/x-c',
    'text/x-cpp',
    'text/x-csharp',
    'text/x-go',
    'text/x-rust',
    'text/x-ruby',
    'text/x-php',
    'text/html',
    'text/css',
    'text/x-scss',
    'text/x-sass',
    'text/x-less',
    'application/json',
    'text/yaml',
    'text/x-yaml',
    'text/markdown',
    'text/x-markdown',
    'text/xml',
    'application/xml',
    'text/x-sh',
    'text/x-shellscript',
    'application/x-sql',
  ],
  text: ['text/plain'],
};

export const ACCEPTED_EXTENSIONS = [
  // Images
  '.jpg', '.jpeg', '.png', '.gif', '.webp',
  // Videos
  '.mp4', '.mov', '.webm', '.avi',
  // Archives
  '.zip', '.7z', '.rar', '.gz', '.tar', '.tgz',
  // Documents
  '.pdf',
  // Code files
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.pyw',
  '.java',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.cxx',
  '.cs',
  '.go',
  '.rs',
  '.rb',
  '.php',
  '.html', '.htm',
  '.css', '.scss', '.sass', '.less',
  '.json', '.jsonc',
  '.yaml', '.yml',
  '.md', '.mdx',
  '.xml',
  '.sh', '.bash', '.zsh',
  '.sql',
  '.vue', '.svelte',
  '.swift',
  '.kt', '.kts',
  '.r', '.R',
  '.lua',
  '.pl', '.pm',
  '.ex', '.exs',
  '.hs',
  '.clj', '.cljs',
  '.scala',
  '.dart',
  // Text
  '.txt', '.log', '.env', '.gitignore', '.dockerignore',
];

export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
export const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB for base64 encoding

// File type categories
export type FileCategory = 'image' | 'video' | 'archive' | 'pdf' | 'code' | 'text' | 'unknown';

export interface FileAttachment {
  id: string;
  file: File;
  name: string;
  size: number;
  type: string;
  category: FileCategory;
  preview?: string; // base64 data URL for images
  language?: string; // for code files
  content?: string; // extracted text content
  status: 'pending' | 'processing' | 'ready' | 'error';
  error?: string;
}

/**
 * Generate a unique ID for attachments
 */
export function generateAttachmentId(): string {
  return `att_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Determine file category from MIME type and extension
 */
export function getFileCategory(file: File): FileCategory {
  const { type, name } = file;
  const ext = name.toLowerCase().split('.').pop() || '';

  // Check images
  if (ACCEPTED_FILE_TYPES.images.includes(type) || 
      ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(`.${ext}`)) {
    return 'image';
  }

  // Check videos
  if (
    ACCEPTED_FILE_TYPES.videos.includes(type) ||
    ['.mp4', '.mov', '.webm', '.avi'].includes(`.${ext}`)
  ) {
    return 'video';
  }

  // Check archives
  if (
    ACCEPTED_FILE_TYPES.archives.includes(type) ||
    ['.zip', '.7z', '.rar', '.gz', '.tar', '.tgz'].includes(`.${ext}`)
  ) {
    return 'archive';
  }

  // Check PDF
  if (type === 'application/pdf' || ext === 'pdf') {
    return 'pdf';
  }

  // Check code files
  if (ACCEPTED_FILE_TYPES.code.includes(type) || isCodeFile(name)) {
    return 'code';
  }

  // Check text files
  if (type.startsWith('text/') || ACCEPTED_FILE_TYPES.text.includes(type)) {
    return 'text';
  }

  return 'unknown';
}

/**
 * Check if file is a code file based on extension
 */
export function isCodeFile(filename: string): boolean {
  const ext = filename.toLowerCase().split('.').pop() || '';
  const codeExtensions = [
    'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
    'py', 'pyw',
    'java',
    'c', 'h', 'cpp', 'hpp', 'cc', 'cxx',
    'cs',
    'go',
    'rs',
    'rb',
    'php',
    'html', 'htm',
    'css', 'scss', 'sass', 'less',
    'json', 'jsonc',
    'yaml', 'yml',
    'md', 'mdx',
    'xml',
    'sh', 'bash', 'zsh',
    'sql',
    'vue', 'svelte',
    'swift',
    'kt', 'kts',
    'r',
    'lua',
    'pl', 'pm',
    'ex', 'exs',
    'hs',
    'clj', 'cljs',
    'scala',
    'dart',
  ];
  return codeExtensions.includes(ext);
}

/**
 * Get programming language from file extension
 */
export function getLanguageFromFile(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() || '';
  const languageMap: Record<string, string> = {
    js: 'JavaScript',
    jsx: 'JavaScript (JSX)',
    ts: 'TypeScript',
    tsx: 'TypeScript (TSX)',
    mjs: 'JavaScript (ESM)',
    cjs: 'JavaScript (CommonJS)',
    py: 'Python',
    pyw: 'Python',
    java: 'Java',
    c: 'C',
    h: 'C Header',
    cpp: 'C++',
    hpp: 'C++ Header',
    cc: 'C++',
    cxx: 'C++',
    cs: 'C#',
    go: 'Go',
    rs: 'Rust',
    rb: 'Ruby',
    php: 'PHP',
    html: 'HTML',
    htm: 'HTML',
    css: 'CSS',
    scss: 'SCSS',
    sass: 'Sass',
    less: 'Less',
    json: 'JSON',
    jsonc: 'JSON with Comments',
    yaml: 'YAML',
    yml: 'YAML',
    md: 'Markdown',
    mdx: 'MDX',
    xml: 'XML',
    sh: 'Shell',
    bash: 'Bash',
    zsh: 'Zsh',
    sql: 'SQL',
    vue: 'Vue',
    svelte: 'Svelte',
    swift: 'Swift',
    kt: 'Kotlin',
    kts: 'Kotlin Script',
    r: 'R',
    lua: 'Lua',
    pl: 'Perl',
    pm: 'Perl Module',
    ex: 'Elixir',
    exs: 'Elixir Script',
    hs: 'Haskell',
    clj: 'Clojure',
    cljs: 'ClojureScript',
    scala: 'Scala',
    dart: 'Dart',
    txt: 'Plain Text',
    log: 'Log File',
    env: 'Environment',
    gitignore: 'Git Ignore',
    dockerignore: 'Docker Ignore',
  };
  return languageMap[ext] || 'Plain Text';
}

/**
 * Get icon name for file type (lucide-react icon names)
 */
export function getFileIcon(category: FileCategory, filename?: string): string {
  if (category === 'image') {return 'Image';}
  if (category === 'video') {return 'Film';}
  if (category === 'archive') {return 'Archive';}
  if (category === 'pdf') {return 'FileText';}
  if (category === 'code') {
    if (filename) {
      const ext = filename.toLowerCase().split('.').pop() || '';
      if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'].includes(ext)) {return 'Braces';}
      if (['py', 'pyw'].includes(ext)) {return 'Code2';}
      if (['html', 'htm', 'xml'].includes(ext)) {return 'FileCode';}
      if (['css', 'scss', 'sass', 'less'].includes(ext)) {return 'Palette';}
      if (['json', 'yaml', 'yml'].includes(ext)) {return 'FileJson';}
      if (['md', 'mdx'].includes(ext)) {return 'FileText';}
      if (['sh', 'bash', 'zsh'].includes(ext)) {return 'Terminal';}
      if (['sql'].includes(ext)) {return 'Database';}
    }
    return 'FileCode2';
  }
  if (category === 'text') {return 'FileText';}
  return 'File';
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) {return '0 B';}
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Validate file for upload
 */
export function validateFile(file: File): { valid: boolean; error?: string } {
  // Check file size
  if (file.size > MAX_FILE_SIZE) {
    return { valid: false, error: `File too large (max ${formatFileSize(MAX_FILE_SIZE)})` };
  }

  // Check if file type/extension is accepted
  const ext = `.${file.name.toLowerCase().split('.').pop() || ''}`;
  const isAcceptedType = [
    ...ACCEPTED_FILE_TYPES.images,
    ...ACCEPTED_FILE_TYPES.videos,
    ...ACCEPTED_FILE_TYPES.archives,
    ...ACCEPTED_FILE_TYPES.documents,
    ...ACCEPTED_FILE_TYPES.code,
    ...ACCEPTED_FILE_TYPES.text,
  ].includes(file.type);
  const isAcceptedExt = ACCEPTED_EXTENSIONS.includes(ext);

  if (!isAcceptedType && !isAcceptedExt) {
    return { valid: false, error: 'File type not supported' };
  }

  return { valid: true };
}

/**
 * Convert file to base64 data URL
 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Failed to read file'));
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Read file as text
 */
export function fileToText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Failed to read file'));
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/**
 * Process a file for attachment
 */
export async function processFile(file: File): Promise<FileAttachment> {
  const id = generateAttachmentId();
  const category = getFileCategory(file);
  const language = category === 'code' ? getLanguageFromFile(file.name) : undefined;

  const attachment: FileAttachment = {
    id,
    file,
    name: file.name,
    size: file.size,
    type: file.type,
    category,
    language,
    status: 'processing',
  };

  try {
    // Generate preview for images
    if (category === 'image') {
      if (file.size <= MAX_IMAGE_SIZE) {
        attachment.preview = await fileToBase64(file);
      } else {
        // Create a thumbnail for large images
        attachment.preview = await createImageThumbnail(file, 200);
      }
    }

    // Extract text content for code/text files
    if (category === 'code' || category === 'text') {
      attachment.content = await fileToText(file);
    }

    attachment.status = 'ready';
  } catch (error) {
    attachment.status = 'error';
    attachment.error = error instanceof Error ? error.message : 'Failed to process file';
  }

  return attachment;
}

/**
 * Create a thumbnail from an image file
 */
export function createImageThumbnail(file: File, maxSize: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);

      const canvas = document.createElement('canvas');
      let { width, height } = img;

      // Calculate new dimensions
      if (width > height) {
        if (width > maxSize) {
          height = (height * maxSize) / width;
          width = maxSize;
        }
      } else {
        if (height > maxSize) {
          width = (width * maxSize) / height;
          height = maxSize;
        }
      }

      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Failed to get canvas context'));
        return;
      }

      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image'));
    };

    img.src = url;
  });
}

/**
 * Get file from clipboard paste event
 */
export function getFilesFromClipboard(e: ClipboardEvent): File[] {
  const items = e.clipboardData?.items;
  if (!items) {return [];}

  const files: File[] = [];
  for (const item of items) {
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) {files.push(file);}
    }
  }
  return files;
}

/**
 * Get files from drag event
 */
export function getFilesFromDrag(e: DragEvent): File[] {
  const items = e.dataTransfer?.files;
  if (!items) {return [];}
  return Array.from(items);
}

/**
 * Build accept string for file input
 */
export function buildAcceptString(): string {
  return [
    ...ACCEPTED_FILE_TYPES.images,
    ...ACCEPTED_FILE_TYPES.videos,
    ...ACCEPTED_FILE_TYPES.archives,
    ...ACCEPTED_FILE_TYPES.documents,
    ...ACCEPTED_FILE_TYPES.code,
    ...ACCEPTED_FILE_TYPES.text,
    ...ACCEPTED_EXTENSIONS,
  ].join(',');
}

/**
 * Prepare attachment data for sending to API
 */
export async function prepareAttachmentForSend(attachment: FileAttachment): Promise<{
  name: string;
  type: string;
  size: number;
  category: FileCategory;
  language?: string;
  data?: string; // base64 for images
  content?: string; // text content for code/text files
}> {
  const result: ReturnType<typeof prepareAttachmentForSend> extends Promise<infer T> ? T : never = {
    name: attachment.name,
    type: attachment.type,
    size: attachment.size,
    category: attachment.category,
    language: attachment.language,
  };

  if (attachment.category === 'image' && attachment.preview) {
    result.data = attachment.preview;
  }

  if ((attachment.category === 'code' || attachment.category === 'text') && attachment.content) {
    result.content = attachment.content;
  }

  // For PDFs, we just send metadata - server handles extraction
  return result;
}
