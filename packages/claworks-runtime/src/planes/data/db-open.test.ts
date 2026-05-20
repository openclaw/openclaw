import { describe, expect, it } from "vitest";
import { openDatabase } from "./db-open.js";
import { convertPlaceholders, isPostgresDatabaseUrl } from "./db-pg.js";

describe("openDatabase", () => {
  it("opens sqlite by default", () => {
    const { db, close, dialect } = openDatabase("sqlite://:memory:");
    expect(dialect).toBe("sqlite");
    db.exec("SELECT 1");
    close();
  });
});

describe("isPostgresDatabaseUrl", () => {
  it("detects postgres URLs", () => {
    expect(isPostgresDatabaseUrl("postgresql://localhost/db")).toBe(true);
    expect(isPostgresDatabaseUrl("postgres://u:p@host/db")).toBe(true);
    expect(isPostgresDatabaseUrl("sqlite://:memory:")).toBe(false);
  });
});

describe("postgres placeholders", () => {
  it("converts ? to $n", () => {
    expect(convertPlaceholders("SELECT * FROM t WHERE id = ? AND x = ?")).toBe(
      "SELECT * FROM t WHERE id = $1 AND x = $2",
    );
  });
});
