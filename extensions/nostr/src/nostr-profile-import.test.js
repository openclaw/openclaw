import { describe, it, expect } from "vitest";
import { mergeProfiles } from "./nostr-profile-import.js";
describe("nostr-profile-import", () => {
  describe("mergeProfiles", () => {
    it("returns empty object when both are undefined", () => {
      const result = mergeProfiles(void 0, void 0);
      expect(result).toEqual({});
    });
    it("returns imported when local is undefined", () => {
      const imported = {
        name: "imported",
        displayName: "Imported User",
        about: "Bio from relay"
      };
      const result = mergeProfiles(void 0, imported);
      expect(result).toEqual(imported);
    });
    it("returns local when imported is undefined", () => {
      const local = {
        name: "local",
        displayName: "Local User"
      };
      const result = mergeProfiles(local, void 0);
      expect(result).toEqual(local);
    });
    it("prefers local values over imported", () => {
      const local = {
        name: "localname",
        about: "Local bio"
      };
      const imported = {
        name: "importedname",
        displayName: "Imported Display",
        about: "Imported bio",
        picture: "https://example.com/pic.jpg"
      };
      const result = mergeProfiles(local, imported);
      expect(result.name).toBe("localname");
      expect(result.displayName).toBe("Imported Display");
      expect(result.about).toBe("Local bio");
      expect(result.picture).toBe("https://example.com/pic.jpg");
    });
    it("fills all missing fields from imported", () => {
      const local = {
        name: "myname"
      };
      const imported = {
        name: "theirname",
        displayName: "Their Name",
        about: "Their bio",
        picture: "https://example.com/pic.jpg",
        banner: "https://example.com/banner.jpg",
        website: "https://example.com",
        nip05: "user@example.com",
        lud16: "user@getalby.com"
      };
      const result = mergeProfiles(local, imported);
      expect(result.name).toBe("myname");
      expect(result.displayName).toBe("Their Name");
      expect(result.about).toBe("Their bio");
      expect(result.picture).toBe("https://example.com/pic.jpg");
      expect(result.banner).toBe("https://example.com/banner.jpg");
      expect(result.website).toBe("https://example.com");
      expect(result.nip05).toBe("user@example.com");
      expect(result.lud16).toBe("user@getalby.com");
    });
    it("handles empty strings as falsy (prefers imported)", () => {
      const local = {
        name: "",
        displayName: ""
      };
      const imported = {
        name: "imported",
        displayName: "Imported"
      };
      const result = mergeProfiles(local, imported);
      expect(result.name).toBe("");
      expect(result.displayName).toBe("");
    });
    it("handles null values in local (prefers imported)", () => {
      const local = {
        name: void 0,
        displayName: void 0
      };
      const imported = {
        name: "imported",
        displayName: "Imported"
      };
      const result = mergeProfiles(local, imported);
      expect(result.name).toBe("imported");
      expect(result.displayName).toBe("Imported");
    });
  });
});
