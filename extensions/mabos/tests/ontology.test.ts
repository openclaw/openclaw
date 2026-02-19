/**
 * MABOS Ontology Tests
 *
 * Validates ontology loading, cross-references, and shapes.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";

// Resolve to source ontology dir (jsonld files aren't compiled to dist/)
const ONTOLOGY_DIR = join(import.meta.dirname, "..", "src", "ontology");

function loadOntology(filename: string) {
  return JSON.parse(readFileSync(join(ONTOLOGY_DIR, filename), "utf-8"));
}

function loadAllOntologies() {
  const files = readdirSync(ONTOLOGY_DIR).filter(
    (f) => f.endsWith(".jsonld") && f !== "shapes.jsonld",
  );
  const ontologies = new Map<string, any>();
  for (const f of files) {
    const ont = loadOntology(f);
    ontologies.set(ont["@id"], ont);
  }
  return ontologies;
}

function collectClasses(ontologies: Map<string, any>): Set<string> {
  const classes = new Set<string>();
  for (const [, ont] of ontologies) {
    for (const node of ont["@graph"]) {
      if (node["@type"] === "owl:Class") classes.add(node["@id"]);
    }
  }
  return classes;
}

// ── Tests ──

describe("Ontology Files", () => {
  it("should have all expected ontology files", () => {
    const files = readdirSync(ONTOLOGY_DIR).filter(
      (f) => f.endsWith(".jsonld") && !f.startsWith("shapes"),
    );
    assert.ok(
      files.length >= 8,
      `Expected at least 8 ontology files, got ${files.length}: ${files.join(", ")}`,
    );
  });

  it("should have shapes file", () => {
    const shapes = loadOntology("shapes.jsonld");
    assert.ok(shapes["@graph"], "Shapes should have @graph");
    assert.ok(
      shapes["@graph"].length >= 10,
      `Expected at least 10 shapes, got ${shapes["@graph"].length}`,
    );
  });

  it("should parse all ontologies as valid JSON-LD", () => {
    const files = readdirSync(ONTOLOGY_DIR).filter((f) => f.endsWith(".jsonld"));
    for (const f of files) {
      assert.doesNotThrow(() => loadOntology(f), `Failed to parse ${f}`);
    }
  });
});

describe("Ontology Structure", () => {
  it("should have at least 160 classes total", () => {
    const ontologies = loadAllOntologies();
    const classes = collectClasses(ontologies);
    assert.ok(classes.size >= 160, `Expected at least 160 classes, got ${classes.size}`);
  });

  it("should have correct import chains", () => {
    const ontologies = loadAllOntologies();
    for (const [ontId, ont] of ontologies) {
      if (!ont["owl:imports"]) continue;
      const imports = Array.isArray(ont["owl:imports"]) ? ont["owl:imports"] : [ont["owl:imports"]];
      for (const imp of imports) {
        assert.ok(ontologies.has(imp), `${ontId} imports "${imp}" which is not loaded`);
      }
    }
  });

  it("should have all subClassOf references resolve", () => {
    const ontologies = loadAllOntologies();
    const classes = collectClasses(ontologies);
    for (const [ontId, ont] of ontologies) {
      for (const node of ont["@graph"]) {
        if (node["rdfs:subClassOf"] && typeof node["rdfs:subClassOf"] === "string") {
          if (!node["rdfs:subClassOf"].startsWith("schema:")) {
            assert.ok(
              classes.has(node["rdfs:subClassOf"]),
              `${ontId}: ${node["@id"]} subClassOf ${node["rdfs:subClassOf"]} is undefined`,
            );
          }
        }
      }
    }
  });

  it("should have all domain references resolve to classes", () => {
    const ontologies = loadAllOntologies();
    const classes = collectClasses(ontologies);
    for (const [ontId, ont] of ontologies) {
      for (const node of ont["@graph"]) {
        if (
          (node["@type"] === "owl:ObjectProperty" || node["@type"] === "owl:DatatypeProperty") &&
          node["rdfs:domain"] &&
          typeof node["rdfs:domain"] === "string"
        ) {
          assert.ok(
            classes.has(node["rdfs:domain"]),
            `${ontId}: ${node["@id"]} domain "${node["rdfs:domain"]}" is undefined`,
          );
        }
      }
    }
  });

  it("should have all range references resolve", () => {
    const ontologies = loadAllOntologies();
    const classes = collectClasses(ontologies);
    const xsdTypes = new Set([
      "xsd:string",
      "xsd:integer",
      "xsd:float",
      "xsd:decimal",
      "xsd:boolean",
      "xsd:dateTime",
      "xsd:date",
    ]);
    for (const [ontId, ont] of ontologies) {
      for (const node of ont["@graph"]) {
        if (
          (node["@type"] === "owl:ObjectProperty" || node["@type"] === "owl:DatatypeProperty") &&
          node["rdfs:range"] &&
          typeof node["rdfs:range"] === "string"
        ) {
          assert.ok(
            classes.has(node["rdfs:range"]) || xsdTypes.has(node["rdfs:range"]),
            `${ontId}: ${node["@id"]} range "${node["rdfs:range"]}" is undefined`,
          );
        }
      }
    }
  });

  it("should have rdfs:comment on all classes", () => {
    const ontologies = loadAllOntologies();
    for (const [ontId, ont] of ontologies) {
      for (const node of ont["@graph"]) {
        if (node["@type"] === "owl:Class") {
          assert.ok(node["rdfs:comment"], `${ontId}: ${node["@id"]} missing rdfs:comment`);
        }
      }
    }
  });

  it("should have rdfs:label on all classes", () => {
    const ontologies = loadAllOntologies();
    for (const [ontId, ont] of ontologies) {
      for (const node of ont["@graph"]) {
        if (node["@type"] === "owl:Class") {
          assert.ok(node["rdfs:label"], `${ontId}: ${node["@id"]} missing rdfs:label`);
        }
      }
    }
  });
});

describe("Domain Ontologies", () => {
  const domains = [
    { file: "ecommerce.jsonld", prefix: "ecom:", minClasses: 15 },
    { file: "saas.jsonld", prefix: "saas:", minClasses: 15 },
    { file: "consulting.jsonld", prefix: "consult:", minClasses: 15 },
    { file: "marketplace.jsonld", prefix: "mkt:", minClasses: 15 },
    { file: "retail.jsonld", prefix: "retail:", minClasses: 15 },
  ];

  for (const domain of domains) {
    it(`should have sufficient classes in ${domain.file}`, () => {
      const ont = loadOntology(domain.file);
      const classes = ont["@graph"].filter((n: any) => n["@type"] === "owl:Class");
      assert.ok(
        classes.length >= domain.minClasses,
        `${domain.file}: expected at least ${domain.minClasses} classes, got ${classes.length}`,
      );
    });

    it(`should import business-core in ${domain.file}`, () => {
      const ont = loadOntology(domain.file);
      const imports = ont["owl:imports"];
      assert.ok(
        imports === "https://mabos.io/ontology/business-core" ||
          (Array.isArray(imports) && imports.includes("https://mabos.io/ontology/business-core")),
        `${domain.file} should import business-core`,
      );
    });
  }
});

describe("Cross-Domain Ontology", () => {
  it("should import all domain ontologies", () => {
    const ont = loadOntology("cross-domain.jsonld");
    const imports = ont["owl:imports"];
    assert.ok(Array.isArray(imports), "cross-domain should import multiple ontologies");
    assert.ok(imports.length >= 6, `Expected at least 6 imports, got ${imports.length}`);
  });

  it("should have inter-domain object properties", () => {
    const ont = loadOntology("cross-domain.jsonld");
    const objProps = ont["@graph"].filter((n: any) => n["@type"] === "owl:ObjectProperty");
    assert.ok(
      objProps.length >= 8,
      `Expected at least 8 cross-domain properties, got ${objProps.length}`,
    );
  });

  it("should have portfolio-level classes", () => {
    const ont = loadOntology("cross-domain.jsonld");
    const classes = ont["@graph"]
      .filter((n: any) => n["@type"] === "owl:Class")
      .map((n: any) => n["@id"]);
    assert.ok(classes.includes("mabos:PortfolioMetric"), "Should have PortfolioMetric class");
    assert.ok(classes.includes("mabos:Synergy"), "Should have Synergy class");
  });
});

describe("SHACL Shapes", () => {
  it("should validate key business classes", () => {
    const shapes = loadOntology("shapes.jsonld");
    const shapeIds = shapes["@graph"].map((s: any) => s["@id"]);
    const required = [
      "mabos:AgentShape",
      "mabos:BusinessShape",
      "mabos:DecisionShape",
      "mabos:GoalShape",
    ];
    for (const id of required) {
      assert.ok(shapeIds.includes(id), `Missing shape: ${id}`);
    }
  });

  it("should have property constraints", () => {
    const shapes = loadOntology("shapes.jsonld");
    for (const shape of shapes["@graph"]) {
      assert.ok(shape["sh:property"], `Shape ${shape["@id"]} has no property constraints`);
      assert.ok(
        shape["sh:property"].length > 0,
        `Shape ${shape["@id"]} has empty property constraints`,
      );
    }
  });
});
