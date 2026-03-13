/**
 * Smart Router Index
 * 
 * Main entry point for the escalation gate system.
 */

const { determineLevel, executeWithGate, cronJobNeedsAI } = require('./escalation-gate');
const { retrieve, store, cleanupExpired } = require('./unified-memory');
const { createTrace, loadTraces, analyzeTraces, generateRecommendations } = require('./trace-standard');
const { processRequest, runCronJob, classifyRequest } = require('./smart-router');

module.exports = {
  // Escalation Gate
  determineLevel,
  executeWithGate,
  cronJobNeedsAI,
  
  // Unified Memory
  retrieve,
  store,
  cleanupExpired,
  
  // Trace Standard
  createTrace,
  loadTraces,
  analyzeTraces,
  generateRecommendations,
  
  // Smart Router
  processRequest,
  runCronJob,
  classifyRequest
};
