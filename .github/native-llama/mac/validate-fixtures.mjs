import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const packet = path.dirname(new URL(import.meta.url).pathname);
const source = path.resolve(process.argv[2]);
// Bundle the real TS import closure exactly like prepare-native-protocol.mjs.
// Node's native strip-types does not remap its maintained .js import specifiers.
const dependencies = path.resolve(process.argv[3] ?? source);
const require = createRequire(path.join(dependencies, 'packages/gateway-protocol/package.json'));
const { build } = await import(pathToFileURL(require.resolve('esbuild')));
const bundle = await build({
  stdin: { contents: `export * from ${JSON.stringify(path.join(source, 'packages/gateway-protocol/src/schema/wizard.ts'))};\nexport { Check } from ${JSON.stringify(require.resolve('typebox/value'))};`, resolveDir: source, loader: 'ts' },
  alias: { typebox: require.resolve('typebox'), 'typebox/value': require.resolve('typebox/value') },
  bundle: true, format: 'esm', platform: 'node', target: 'node24', write: false,
});
const wizard = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
const { Check } = wizard;
const get = name => JSON.parse(fs.readFileSync(path.join(packet,'fixtures',name),'utf8'));
const note = get('install-note.json'), endpoint=get('endpoint.json'), detect=get('detect.json');
assert(Check(wizard.WizardStartResultSchema,{sessionId:'fixture-session',...note}));
assert(Check(wizard.WizardNextResultSchema,endpoint));
assert(Check(wizard.WizardNextParamsSchema,{sessionId:'fixture-session',answer:{stepId:note.step.id}}));
const manifest=JSON.parse(fs.readFileSync(path.join(source,'extensions/llama-cpp/openclaw.plugin.json'),'utf8'));
const meta=manifest.providerAuthChoices.find(x=>x.choiceId==='llama-app');
const llama=detect.prepareOptions.find(x=>x.id==='llama-app');
assert.equal(llama.brandId,meta.provider);assert.equal(llama.label,meta.choiceLabel);
assert.equal(llama.hint,meta.choiceHint);assert.equal(llama.actionLabel,meta.appGuidedActionLabel);assert.equal(llama.website,meta.website);
const registration=fs.readFileSync(path.join(source,'extensions/llama-cpp/src/external-server/registration.ts'),'utf8');
assert(registration.includes(JSON.stringify(note.step.message)));assert(registration.includes(JSON.stringify(note.step.title)));
const setup=fs.readFileSync(path.join(source,'extensions/llama-cpp/src/external-server/setup.ts'),'utf8');
assert(setup.includes('message: ' + String.fromCharCode(96) + '$' + '{server.label} URL' + String.fromCharCode(96)));
const defaults=fs.readFileSync(path.join(source,'extensions/llama-cpp/src/external-server/defaults.ts'),'utf8');
assert(defaults.includes('defaultOrigin: '+JSON.stringify(endpoint.step.placeholder)));
assert.equal(endpoint.step.message,'Llama URL');
assert.equal(detect.candidates[0].kind,'existing-model');assert.equal(detect.setupComplete,false);
console.log(JSON.stringify({status:'PASS',boundary:'real Gateway wire schemas plus exact provider metadata/note/endpoint source contracts',fixtureActivation:false},null,2));
