
const content = `# Header
tasks:
- name: unindented
  interval: 1m
- name: another
Some other key
`;

const regex = /^tasks:(?:\r?\n(?:[ \t-].*|$))*/m;
const result = content.replace(regex, "---STRIPPED---");
console.log("RESULT:");
console.log(result);
console.log("---");
if (result.includes("name: inbox")) {
  console.log("FAILED: name: inbox still present");
} else {
  console.log("SUCCESS: name: inbox stripped");
}
