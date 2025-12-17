import fs, { promises } from 'node:fs';
import { resolve } from 'node:path';
import { Ollama as Ollama$1 } from './browser.mjs';
import 'whatwg-fetch';

class Ollama extends Ollama$1 {
  async encodeImage(image) {
    if (typeof image !== "string") {
      return Buffer.from(image).toString("base64");
    }
    try {
      if (fs.existsSync(image)) {
        const fileBuffer = await promises.readFile(resolve(image));
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
      await promises.access(path);
      return true;
    } catch {
      return false;
    }
  }
  async create(request) {
    if (request.from && await this.fileExists(resolve(request.from))) {
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

export { Ollama, index as default };
