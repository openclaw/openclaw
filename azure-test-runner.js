// azure-test-runner.js
// Node.js script to run and print Azure Bay scenarios with Q&A




const AZURE_SCENARIOS_ENDPOINT = 'http://127.0.0.1:3740/api/az/test-scenarios';
const TRIAGE_API_ENDPOINT = 'http://127.0.0.1:3740/api/triage'; // Adjust if needed

async function run() {
  console.log('Fetching Azure Bay test scenarios...');
  const scenariosRes = await fetch(AZURE_SCENARIOS_ENDPOINT);
  if (!scenariosRes.ok) {throw new Error('Failed to fetch scenarios');}
  const scenarios = await scenariosRes.json();
  // Support both array and { scenarios } object
  const azureScenarios = Array.isArray(scenarios) ? scenarios : scenarios.scenarios;
  // If endpoint returns mixed data, filter here:
  // const azureScenarios = azureScenarios.filter(s => s.property === 'Azure Bay Residences');

  let pass = 0, warn = 0, fail = 0;
  for (const scn of azureScenarios) {
    // Robust mapping for legacy and new formats
    const id = scn.id || scn["Scenario ID"] || scn.scenario_id || scn.intent_id || '';
    const question = scn.question || scn["Message"] || scn.msg || scn.prompt || '';
    const expected = scn.expected || scn["Expected"] || '';
    const meta = scn.meta || {};
    // Send the question to the triage engine
    const triageRes = await fetch(TRIAGE_API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: question, meta })
    });
    let answer, status = 'fail';
    if (triageRes.ok) {
      const data = await triageRes.json();
      answer = data.answer || JSON.stringify(data);
      // Simple pass/warn/fail logic (customize as needed)
      if (answer === expected) {status = 'pass';}
      else if (answer == null || answer === '' || answer === 'null') {status = 'warn';}
      else {status = 'fail';}
    } else {
      answer = `Error: ${triageRes.status} ${triageRes.statusText}`;
    }
    if (status === 'pass') {pass++;} else if (status === 'warn') {warn++;} else {fail++;}
    console.log(`\nScenario: ${id}`);
    console.log(`Q: ${question}`);
    console.log(`A: ${answer}`);
    console.log(`Expected: ${expected}`);
    console.log(`Result: ${status.toUpperCase()}`);
  }
  console.log(`\nSummary: ${pass} passed, ${warn} warned, ${fail} failed.`);
}

run().catch(err => { console.error(err); process.exit(1); });
