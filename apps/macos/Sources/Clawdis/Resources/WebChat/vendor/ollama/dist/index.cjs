'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

const fs = require('node:fs');
const node_path = require('node:path');
const browser = require('./browser.cjs');
require('whatwg-fetch');

function _interopDefaultCompat (e) { return e && typeof e === 'object' && 'default' in e ? e.default : e; }

const fs__default = /*#__PURE__*/_interopDefaultCompat(fs);

class Ollama extends browser.Ollama {
  async encodeImage(image) {
    if (typeof image !== "string") {
      return Buffer.from(image).toString("base64");
    }
    try {
      if (fs__default.existsSync(image)) {
        const fileBuffer = await fs.promises.readFile(node_path.resolve(image));
        return Buffer.from(fileBuffer).toString("base64");
      }
    } catch {
    }
    return image;
  }
  /**
   * checks if a file exists
   * @param path {string} - The path to the file
   * @private @internal
   * @returns {Promise<boolean>} - Whether the file exists or not
   */
  async fileExists(path) {
    try {
      await fs.promises.access(path);
      return true;
    } catch {
      return false;
    }
  }
  async create(request) {
    if (request.from && await this.fileExists(node_path.resolve(request.from))) {
      throw Error("Creating with a local path is not currently supported from ollama-js");
    }
    if (request.stream) {
      return super.create(request);
    } else {
      return super.create(request);
    }
  }
}
const index = new Ollama();

exports.Ollama = Ollama;
exports.default = index;
