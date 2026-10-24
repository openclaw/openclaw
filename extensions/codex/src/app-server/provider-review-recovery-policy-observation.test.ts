import assert from 'node:assert/strict';
import { test } from "vitest";
import { readFileSync } from 'node:fs';
import {
  compareRecoveryPolicyObservation,
  recoveryPolicyObservationFields,
  type ExpectedRecoveryPolicyObservation,
} from "./provider-review-recovery-policy-observation.js";

// Synthetic JSON observations only. No owner, provider attestation, native
// subscription, review capability, binding mutation, or successful recovery is
// fabricated by these fixtures. These tests validate a data comparator only.
const fields = {
  model:'fixture-model',modelProvider:'fixture-provider',cwd:'/fixture/workspace',
  runtimeWorkspaceRoots:['/fixture/workspace'],approvalPolicy:'on-request',
  approvalsReviewer:'user',sandbox:{type:'fixture-sandbox',network:false},
  activePermissionProfile:{id:'fixture-profile',revision:'fixture-policy-revision'},
};
type MutableExpected = {threadId:string;fields:Record<(typeof recoveryPolicyObservationFields)[number],unknown>};
const expected = (): MutableExpected => ({threadId:'reviewed-thread-A',fields:structuredClone(fields)});
const response = (): Record<string,unknown> & {thread:{id:string}} => ({thread:{id:'reviewed-thread-A'},...structuredClone(fields)});
const compare=(e:ExpectedRecoveryPolicyObservation,r:unknown)=>{
  const result=compareRecoveryPolicyObservation(e,r);
  assert.equal(result.mutationAuthorized,false);
  assert.ok(result.notEstablished.includes('exclusive-native-subscription-ownership'));
  assert.ok(result.notEstablished.includes('effective-configuration-generation'));
  assert.ok(Object.isFrozen(result));
  return result;
};
test('matching policy fields are data, never permission to recover or acknowledge',()=>assert.equal(compare(expected(),response()).status,'matches_expected_fields'));
test('wrong original native thread is rejected',()=>{
  const r=response();r.thread.id='replacement-thread-B';assert.equal(compare(expected(),r).status,'different');
});
for(const field of recoveryPolicyObservationFields){
  test(`missing native ${field} is unavailable`,()=>{
    const r=response();delete r[field];assert.equal(compare(expected(),r).status,'unavailable');
  });
  test(`changed native ${field} differs`,()=>{
    const r=response();r[field]={changed:true};assert.equal(compare(expected(),r).status,'different');
  });
}
test('unknown permission-profile provenance is unavailable even if both null',()=>{
  const e=expected(),r=response();e.fields.activePermissionProfile=null;r.activePermissionProfile=null;assert.equal(compare(e,r).status,'unavailable');
});
test('incomplete prepared policy cannot silently default to native values',()=>{
  const e=expected();delete (e.fields as Partial<MutableExpected["fields"]>).approvalPolicy;assert.equal(compare(e,response()).status,'unavailable');
});
test('old reduced resume response is insufficient for policy observation',()=>{
  assert.equal(compare(expected(),{thread:{id:'reviewed-thread-A'},model:fields.model,modelProvider:fields.modelProvider,cwd:fields.cwd}).status,'unavailable');
});
test('comparison does not modify caller data',()=>{
  const e=expected(),r=response(),before=structuredClone({e,r});compare(e,r);assert.deepEqual({e,r},before);
});
test('regression plan begins with an already-mismatched pending review, not a fresh prevention case',()=>{
  const p=JSON.parse(readFileSync(new URL("../../../../test/fixtures/provider-review-recovery/plan.json",import.meta.url),'utf8'));
  assert.equal(p.fixture.review.nativeThread,'reviewed-thread-A');
  assert.equal(p.fixture.currentBinding.nativeThread,'replacement-thread-B');
  assert.notEqual(p.fixture.review.nativeThread,p.fixture.currentBinding.nativeThread);
  assert.equal(p.fixture.review.pending,true);
  assert.equal(p.status,'specification_not_executed');
});
