import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { logger } from "./logger.js";

/**
 * Image Processing Module for WeCom
 *
 * Handles loading, validating, and encoding images for WeCom msg_item
 * Supports JPG and PNG formats up to 2MB
 */

// Image format signatures (magic bytes)
const IMAGE_SIGNATURES = {
  JPG: [0xff, 0xd8, 0xff],
  PNG: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
};

// 2MB size limit (before base64 encoding)
const MAX_IMAGE_SIZE = 2 * 1024 * 1024;

/**
 * Load image file from filesystem
 * @param {string} filePath - Absolute path to image file
 * @returns {Promise<Buffer>} Image data buffer
 * @throws {Error} If file not found or cannot be read
 */
export async function loadImageFromPath(filePath) {
  try {
    logger.debug("Loading image from path", { filePath });
    const buffer = await readFile(filePath);
    logger.debug("Image loaded successfully", {
      filePath,
      size: buffer.length,
    });
    return buffer;
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Image file not found: ${filePath}`, { cause: error });
    } else if (error.code === "EACCES") {
      throw new Error(`Permission denied reading image: ${filePath}`, { cause: error });
    } else {
      throw new Error(`Failed to read image file: ${error.message}`, { cause: error });
    }
  }
}

/**
 * Convert buffer to base64 string
 * @param {Buffer} buffer - Image data buffer
 * @returns {string} Base64-encoded string
 */
export function encodeImageToBase64(buffer) {
  return buffer.toString("base64");
}

/**
 * Calculate MD5 checksum of buffer
 * @param {Buffer} buffer - Image data buffer
 * @returns {string} MD5 hash in hexadecimal
 */
export function calculateMD5(buffer) {
  return createHash("md5").update(buffer).digest("hex");
}

/**
 * Validate image size is within limits
 * @param {Buffer} buffer - Image data buffer
 * @throws {Error} If size exceeds 2MB limit
 */
export function validateImageSize(buffer) {
  const sizeBytes = buffer.length;
  const sizeMB = (sizeBytes / 1024 / 1024).toFixed(2);

  if (sizeBytes > MAX_IMAGE_SIZE) {
    throw new Error(`Image size ${sizeMB}MB exceeds 2MB limit (actual: ${sizeBytes} bytes)`);
  }

  logger.debug("Image size validated", { sizeBytes, sizeMB });
}

/**
 * Detect image format from magic bytes
 * @param {Buffer} buffer - Image data buffer
 * @returns {string} Format: "JPG" or "PNG"
 * @throws {Error} If format is not supported
 */
export function detectImageFormat(buffer) {
  // Check PNG signature
  if (buffer.length >= IMAGE_SIGNATURES.PNG.length) {
    const isPNG = IMAGE_SIGNATURES.PNG.every((byte, index) => buffer[index] === byte);
    if (isPNG) {
      logger.debug("Image format detected: PNG");
      return "PNG";
    }
  }

  // Check JPG signature
  if (buffer.length >= IMAGE_SIGNATURES.JPG.length) {
    const isJPG = IMAGE_SIGNATURES.JPG.every((byte, index) => buffer[index] === byte);
    if (isJPG) {
      logger.debug("Image format detected: JPG");
      return "JPG";
    }
  }

  // Unknown format
  const header = buffer.subarray(0, 16).toString("hex");
  throw new Error(
    `Unsupported image format. Only JPG and PNG are supported. File header: ${header}`,
  );
}

/**
 * Complete image processing pipeline
 *
 * Loads image from filesystem, validates format and size,
 * then encodes to base64 and calculates MD5 checksum.
 *
 * @param {string} filePath - Absolute path to image file
 * @returns {Promise<Object>} Processed image data
 * @returns {string} return.base64 - Base64-encoded image data
 * @returns {string} return.md5 - MD5 checksum
 * @returns {string} return.format - Image format (JPG or PNG)
 * @returns {number} return.size - Original size in bytes
 *
 * @throws {Error} If any step fails (file not found, invalid format, size exceeded, etc.)
 *
 * @example
 * const result = await prepareImageForMsgItem('/path/to/image.jpg');
 * // Returns: { base64: "...", md5: "...", format: "JPG", size: 123456 }
 */
export async function prepareImageForMsgItem(filePath) {
  logger.debug("Starting image processing pipeline", { filePath });

  try {
    // Step 1: Load image
    const buffer = await loadImageFromPath(filePath);

    // Step 2: Validate size
    validateImageSize(buffer);

    // Step 3: Detect format
    const format = detectImageFormat(buffer);

    // Step 4: Encode to base64
    const base64 = encodeImageToBase64(buffer);

    // Step 5: Calculate MD5
    const md5 = calculateMD5(buffer);

    logger.info("Image processed successfully", {
      filePath,
      format,
      size: buffer.length,
      md5,
      base64Length: base64.length,
    });

    return {
      base64,
      md5,
      format,
      size: buffer.length,
    };
  } catch (error) {
    logger.error("Image processing failed", {
      filePath,
      error: error.message,
    });
    throw error;
  }
}
