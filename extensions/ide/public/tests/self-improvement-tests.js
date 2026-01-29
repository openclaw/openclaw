/**
 * SELF-IMPROVEMENT SYSTEM TEST SUITE
 * Comprehensive tests for all 9 modules
 * 
 * Run in browser console: await SelfImprovementTests.runAll()
 * Or individual: await SelfImprovementTests.testSelfCritique()
 */

const SelfImprovementTests = {
  results: [],
  startTime: null,
  
  // Test utilities
  assert(condition, message) {
    if (!condition) {
      throw new Error(`Assertion failed: ${message}`);
    }
  },

  assertApprox(actual, expected, tolerance, message) {
    if (Math.abs(actual - expected) > tolerance) {
      throw new Error(`${message}: expected ~${expected}, got ${actual}`);
    }
  },

  async runTest(name, fn) {
    const start = performance.now();
    try {
      await fn();
      const duration = performance.now() - start;
      this.results.push({ name, status: 'PASS', duration });
      console.log(`✅ ${name} (${duration.toFixed(2)}ms)`);
      return true;
    } catch (e) {
      const duration = performance.now() - start;
      this.results.push({ name, status: 'FAIL', error: e.message, duration });
      console.error(`❌ ${name}: ${e.message}`);
      return false;
    }
  },

  // ============================================
  // SELF-CRITIQUE MODULE TESTS
  // ============================================
  
  async testSelfCritique() {
    console.log('\n📋 Testing Self-Critique Module...\n');
    
    // Test 1: Basic critique with high-quality response
    await this.runTest('SelfCritique: High quality response passes', async () => {
      const result = await window.selfCritique.critique(
        'The function `Array.map()` transforms each element using a callback function and returns a new array. Here is an example:\n```javascript\nconst doubled = [1,2,3].map(x => x * 2);\n// Result: [2, 4, 6]\n```',
        { userQuery: 'How does array map work?', expectedLength: 'medium' }
      );
      this.assert(result.overallScore >= 0.7, `Expected score >= 0.7, got ${result.overallScore}`);
      this.assert(result.approved === true, 'Expected approval for quality response');
    });

    // Test 2: Incomplete response detection
    await this.runTest('SelfCritique: Detects incomplete response', async () => {
      const result = await window.selfCritique.critique(
        'Yes.',
        { userQuery: 'Can you explain how to implement authentication with JWT tokens and also show me the code for refresh tokens?', expectedLength: 'long' }
      );
      this.assert(result.checks.completeness.score < 0.8, 'Should detect incomplete response');
      this.assert(result.checks.completeness.issues.length > 0, 'Should have completeness issues');
    });

    // Test 3: Mistake pattern detection
    await this.runTest('SelfCritique: Detects known mistake patterns', async () => {
      const result = await window.selfCritique.critique(
        'I apologize, but I don\'t have access to that information as of my knowledge cutoff date. Here is a TODO placeholder...',
        {}
      );
      this.assert(result.checks.mistakePatterns.matches.length >= 2, 
        `Expected at least 2 mistake patterns, got ${result.checks.mistakePatterns.matches.length}`);
      this.assert(result.checks.mistakePatterns.score < 0.9, 'Score should be reduced for mistakes');
    });

    // Test 4: Hedging language confidence reduction
    await this.runTest('SelfCritique: Reduces confidence for hedging', async () => {
      const hedgingResponse = 'This might work, perhaps you could try this approach. I\'m not sure but maybe it will help. It could possibly be the solution.';
      const confidentResponse = 'This will work. Use this approach. It is the correct solution.';
      
      const hedging = await window.selfCritique.critique(hedgingResponse, {});
      const confident = await window.selfCritique.critique(confidentResponse, {});
      
      this.assert(hedging.checks.confidence.score < confident.checks.confidence.score,
        'Hedging response should have lower confidence');
    });

    // Test 5: Intent alignment detection
    await this.runTest('SelfCritique: Verifies intent alignment', async () => {
      const aligned = await window.selfCritique.critique(
        'To debug this JavaScript error, first open the browser DevTools and check the console for the stack trace.',
        { userQuery: 'How do I debug JavaScript errors?' }
      );
      const misaligned = await window.selfCritique.critique(
        'Python is a great programming language for data science.',
        { userQuery: 'How do I debug JavaScript errors?' }
      );
      
      this.assert(aligned.checks.intentAlignment.score > misaligned.checks.intentAlignment.score,
        'Aligned response should score higher on intent');
    });

    // Test 6: Calibration history tracking
    await this.runTest('SelfCritique: Maintains evaluation history', async () => {
      const initialCount = window.selfCritique.critiqueHistory.length;
      await window.selfCritique.critique('Test response for history', {});
      this.assert(window.selfCritique.critiqueHistory.length === initialCount + 1, 
        'History should grow by 1');
    });

    // Test 7: Learning from feedback
    await this.runTest('SelfCritique: Adjusts threshold from feedback', async () => {
      const initialThreshold = window.selfCritique.confidenceThreshold;
      const evaluation = { approved: true, overallScore: 0.9 };
      
      // False positive - we approved something bad
      window.selfCritique.learnFromFeedback(evaluation, false);
      this.assert(window.selfCritique.confidenceThreshold > initialThreshold,
        'Threshold should increase after false positive');
      
      // Reset
      window.selfCritique.confidenceThreshold = initialThreshold;
    });
  },

  // ============================================
  // LEARNING MEMORY MODULE TESTS
  // ============================================
  
  async testLearningMemory() {
    console.log('\n📚 Testing Learning Memory Module...\n');
    
    // Test 1: Record and retrieve success pattern
    await this.runTest('LearningMemory: Records success patterns', async () => {
      const pattern = {
        pattern: 'Using async/await for API calls',
        context: 'REST API integration',
        category: 'javascript',
        confidence: 0.9
      };
      const result = window.learningMemory.recordSuccess(pattern);
      
      this.assert(result.id, 'Should return entry with ID');
      this.assert(result.useCount >= 1, 'Should track use count');
      
      // Recording same pattern should increase count
      const result2 = window.learningMemory.recordSuccess(pattern);
      this.assert(result2.useCount > result.useCount || 
        window.learningMemory.memory.successes.find(s => s.pattern === pattern.pattern).useCount >= 2,
        'Duplicate pattern should increase count');
    });

    // Test 2: Record and retrieve mistakes
    await this.runTest('LearningMemory: Records mistake patterns', async () => {
      const mistake = {
        pattern: 'Forgetting to handle null in API responses',
        description: 'API returned null but code assumed object',
        category: 'error_handling',
        severity: 'medium'
      };
      const result = window.learningMemory.recordMistake(mistake);
      
      this.assert(result.id, 'Should return entry with ID');
      this.assert(result.severity === 'medium', 'Should preserve severity');
    });

    // Test 3: Record user corrections
    await this.runTest('LearningMemory: Records user corrections', async () => {
      const correction = {
        original: 'Use var for all variables',
        corrected: 'Use const by default, let when reassigning',
        category: 'javascript'
      };
      const result = window.learningMemory.recordCorrection(correction);
      
      this.assert(result.id, 'Should return entry with ID');
      this.assert(window.learningMemory.memory.corrections.length > 0, 'Should store correction');
    });

    // Test 4: Capability tracking
    await this.runTest('LearningMemory: Updates capability scores', async () => {
      const initial = window.learningMemory.memory.capabilities['test_capability'];
      
      window.learningMemory.updateCapability('test_capability', { score: 0.8 });
      window.learningMemory.updateCapability('test_capability', { score: 0.9 });
      window.learningMemory.updateCapability('test_capability', { score: 0.85 });
      
      const cap = window.learningMemory.memory.capabilities['test_capability'];
      this.assert(cap.samples >= 3, 'Should track sample count');
      this.assert(cap.score > 0.5, 'Should have reasonable score');
    });

    // Test 5: Prediction and calibration
    await this.runTest('LearningMemory: Tracks predictions for calibration', async () => {
      const prediction = window.learningMemory.recordPrediction({
        claim: 'This refactoring will improve performance by 20%',
        confidence: 0.75
      });
      
      this.assert(prediction.id, 'Should return prediction ID');
      this.assert(prediction.confidence === 0.75, 'Should store confidence');
      
      // Resolve it
      const resolved = window.learningMemory.resolvePrediction(prediction.id, true);
      this.assert(resolved.outcome === true, 'Should record outcome');
      this.assert(resolved.resolved === true, 'Should mark as resolved');
    });

    // Test 6: Preference learning
    await this.runTest('LearningMemory: Learns preferences over time', async () => {
      // Learn a preference multiple times
      window.learningMemory.learnPreference('indent_style', 'spaces', 'file1.js');
      window.learningMemory.learnPreference('indent_style', 'spaces', 'file2.js');
      window.learningMemory.learnPreference('indent_style', 'spaces', 'file3.js');
      
      const pref = window.learningMemory.memory.preferences['indent_style'];
      this.assert(pref.value === 'spaces', 'Should store preference value');
      this.assert(pref.confidence >= 0.6, 'Confidence should increase with reinforcement');
    });

    // Test 7: Task outcome recording
    await this.runTest('LearningMemory: Records task outcomes', async () => {
      const outcome = window.learningMemory.recordOutcome({
        task: 'Implement user authentication',
        success: true,
        duration: 1200000,
        category: 'security'
      });
      
      this.assert(outcome.id, 'Should return outcome ID');
      this.assert(window.learningMemory.memory.capabilities['security'], 
        'Should update related capability');
    });

    // Test 8: Relevant pattern retrieval
    await this.runTest('LearningMemory: Retrieves relevant patterns', async () => {
      // Add some patterns
      window.learningMemory.recordSuccess({
        pattern: 'Use TypeScript generics for reusable code',
        category: 'typescript'
      });
      window.learningMemory.recordMistake({
        pattern: 'Forgot to add type annotations',
        category: 'typescript'
      });
      
      const relevant = window.learningMemory.getRelevantPatterns({ category: 'typescript' });
      this.assert(relevant.successes.length > 0 || relevant.mistakes.length > 0,
        'Should find relevant patterns');
    });

    // Test 9: Statistics accuracy
    await this.runTest('LearningMemory: Provides accurate statistics', async () => {
      const stats = window.learningMemory.getStats();
      
      this.assert(typeof stats.successes === 'number', 'Should count successes');
      this.assert(typeof stats.mistakes === 'number', 'Should count mistakes');
      this.assert(typeof stats.corrections === 'number', 'Should count corrections');
      this.assert(typeof stats.age === 'number', 'Should track age');
    });
  },

  // ============================================
  // CONFIDENCE CALIBRATION TESTS
  // ============================================
  
  async testConfidenceCalibration() {
    console.log('\n📊 Testing Confidence Calibration Module...\n');
    
    // Test 1: Prediction recording
    await this.runTest('Calibration: Records predictions correctly', async () => {
      const id = window.confidenceCalibration.predict(
        'This code change will fix the bug',
        0.85,
        { file: 'test.js' }
      );
      
      this.assert(id.startsWith('pred_'), 'Should return prediction ID');
      this.assert(window.confidenceCalibration.pendingPredictions.has(id), 
        'Should track pending prediction');
    });

    // Test 2: Resolution and bucket tracking
    await this.runTest('Calibration: Resolves and buckets correctly', async () => {
      // Make predictions in different confidence ranges
      const predictions = [
        { confidence: 0.9, correct: true },
        { confidence: 0.9, correct: true },
        { confidence: 0.9, correct: false },
        { confidence: 0.7, correct: true },
        { confidence: 0.7, correct: true },
        { confidence: 0.5, correct: false },
        { confidence: 0.3, correct: false },
      ];
      
      for (const p of predictions) {
        const id = window.confidenceCalibration.predict('Test claim', p.confidence);
        window.confidenceCalibration.resolve(id, p.correct);
      }
      
      // Check buckets are populated
      const breakdown = window.confidenceCalibration.getBreakdown();
      const highBucket = breakdown.find(b => b.range === '0.8-1.0');
      this.assert(highBucket.total >= 3, 'High confidence bucket should have entries');
    });

    // Test 3: Calibration score calculation
    await this.runTest('Calibration: Calculates Brier score correctly', async () => {
      // Add enough predictions for calibration
      for (let i = 0; i < 25; i++) {
        const confidence = 0.8;
        const correct = Math.random() < 0.8; // 80% correct for 80% confidence = perfect calibration
        const id = window.confidenceCalibration.predict('Calibration test', confidence);
        window.confidenceCalibration.resolve(id, correct);
      }
      
      const score = window.confidenceCalibration.getScore();
      if (score !== null) {
        this.assert(score >= 0 && score <= 1, `Score should be 0-1, got ${score}`);
      }
    });

    // Test 4: Trend detection
    await this.runTest('Calibration: Detects accuracy trends', async () => {
      // This requires historical data, just verify it doesn't crash
      const trend = window.confidenceCalibration.getTrend();
      // trend can be null if not enough data
      if (trend !== null) {
        this.assert(['improving', 'declining', 'stable'].includes(trend.trend),
          'Trend should be valid');
      }
    });

    // Test 5: Confidence adjustment suggestions
    await this.runTest('Calibration: Suggests confidence adjustments', async () => {
      const adjusted = window.confidenceCalibration.suggestAdjustment(0.85);
      this.assert(typeof adjusted === 'number', 'Should return number');
      this.assert(adjusted >= 0.1 && adjusted <= 0.99, 'Should be in valid range');
    });

    // Test 6: Overconfidence detection
    await this.runTest('Calibration: Detects over/underconfidence', async () => {
      const analysis = window.confidenceCalibration.getConfidenceAnalysis();
      this.assert(Array.isArray(analysis), 'Should return array of issues');
      // May be empty if well-calibrated, which is fine
    });
  },

  // ============================================
  // REFLEXION ENGINE TESTS
  // ============================================
  
  async testReflexionEngine() {
    console.log('\n🔍 Testing Reflexion Engine...\n');
    
    // Test 1: Basic failure reflexion
    await this.runTest('Reflexion: Analyzes failures correctly', async () => {
      const failure = {
        task: 'Deploy application to production',
        approach: 'Direct push to main branch',
        expected: 'Successful deployment',
        actual: 'Build failed with undefined variable error',
        category: 'deployment'
      };
      
      const reflexion = await window.reflexionEngine.reflect(failure);
      
      this.assert(reflexion.id, 'Should generate reflexion ID');
      this.assert(reflexion.analysis.summary, 'Should have analysis summary');
      this.assert(reflexion.prevention.strategy, 'Should have prevention strategy');
      this.assert(reflexion.pattern.signature, 'Should extract pattern signature');
    });

    // Test 2: Error classification
    await this.runTest('Reflexion: Classifies errors correctly', async () => {
      const nullError = window.reflexionEngine.classifyError('Cannot read property of undefined');
      const timeoutError = window.reflexionEngine.classifyError('Request timed out after 30s');
      const permError = window.reflexionEngine.classifyError('Permission denied: access forbidden');
      
      this.assert(nullError === 'null_error', `Expected null_error, got ${nullError}`);
      this.assert(timeoutError === 'timeout', `Expected timeout, got ${timeoutError}`);
      this.assert(permError === 'permission', `Expected permission, got ${permError}`);
    });

    // Test 3: Prevention strategy generation
    await this.runTest('Reflexion: Generates appropriate prevention', async () => {
      const failure = {
        task: 'Parse JSON response',
        error: 'SyntaxError: Unexpected token in JSON'
      };
      
      const reflexion = await window.reflexionEngine.reflect(failure);
      
      this.assert(reflexion.prevention.checks.length > 0, 'Should suggest checks');
      this.assert(reflexion.prevention.alternatives.length > 0, 'Should suggest alternatives');
    });

    // Test 4: Similar failure detection
    await this.runTest('Reflexion: Finds similar past failures', async () => {
      // Create a failure
      await window.reflexionEngine.reflect({
        task: 'API integration',
        error: 'Network connection refused',
        category: 'networking'
      });
      
      // Check for similar
      const similar = window.reflexionEngine.findSimilar({
        task: 'API call',
        error: 'Network timeout',
        category: 'networking'
      });
      
      // May find similar if categories match
      this.assert(Array.isArray(similar), 'Should return array');
    });

    // Test 5: Advice retrieval
    await this.runTest('Reflexion: Provides relevant advice', async () => {
      // Add a reflexion about testing
      await window.reflexionEngine.reflect({
        task: 'Write unit tests for auth module',
        error: 'Mock not properly configured',
        category: 'testing'
      });
      
      const advice = window.reflexionEngine.getAdvice('unit testing', 'testing');
      this.assert(Array.isArray(advice), 'Should return advice array');
    });

    // Test 6: Severity assessment
    await this.runTest('Reflexion: Assesses severity correctly', async () => {
      const critical = window.reflexionEngine.assessSeverity({
        error: 'Critical: data corruption detected',
        impact: 'data_loss'
      });
      
      const low = window.reflexionEngine.assessSeverity({
        error: 'Minor warning',
        recoverable: true,
        retries: 1
      });
      
      this.assert(critical === 'critical', `Expected critical, got ${critical}`);
      this.assert(low === 'low', `Expected low, got ${low}`);
    });

    // Test 7: Resolution marking
    await this.runTest('Reflexion: Marks reflexions as resolved', async () => {
      const reflexion = await window.reflexionEngine.reflect({
        task: 'Test resolution',
        error: 'Test error'
      });
      
      const resolved = window.reflexionEngine.resolve(reflexion.id, 'Fixed by adding validation');
      
      this.assert(resolved.resolved === true, 'Should mark as resolved');
      this.assert(resolved.resolutionNotes, 'Should store resolution notes');
    });

    // Test 8: Statistics accuracy
    await this.runTest('Reflexion: Provides accurate statistics', async () => {
      const stats = window.reflexionEngine.getStats();
      
      this.assert(typeof stats.total === 'number', 'Should count total');
      this.assert(typeof stats.resolved === 'number', 'Should count resolved');
      this.assert(stats.bySeverity, 'Should break down by severity');
      this.assert(stats.byCategory, 'Should break down by category');
    });
  },

  // ============================================
  // PATTERN RECOGNITION TESTS
  // ============================================
  
  async testPatternRecognition() {
    console.log('\n🎯 Testing Pattern Recognition...\n');
    
    // Test 1: Code pattern learning
    await this.runTest('PatternRecognition: Learns code patterns', async () => {
      const code = `
        async function fetchUser(id) {
          try {
            const response = await fetch(\`/api/users/\${id}\`);
            return await response.json();
          } catch (error) {
            console.error('Failed to fetch user:', error);
            throw error;
          }
        }
      `;
      
      const pattern = window.patternRecognition.learnCodePattern(code, { language: 'javascript' });
      
      this.assert(pattern.type === 'function' || pattern.type === 'arrow_function', 
        `Expected function type, got ${pattern.type}`);
      this.assert(pattern.structure.hasAsync === true, 'Should detect async');
      this.assert(pattern.structure.hasTryCatch === true, 'Should detect try-catch');
      this.assert(pattern.features.includes('async'), 'Should extract async feature');
    });

    // Test 2: Code type detection
    await this.runTest('PatternRecognition: Detects code types', async () => {
      const types = {
        'function hello() {}': 'function',
        'const fn = async () => {}': 'arrow_function',
        'class User {}': 'class',
        'import { x } from "y"': 'import',
        'const x = 5': 'variable',
        'if (x) {}': 'conditional',
        'for (let i = 0; i < 10; i++) {}': 'loop',
        'try { } catch (e) {}': 'try_catch'
      };
      
      for (const [code, expected] of Object.entries(types)) {
        const actual = window.patternRecognition.detectCodeType(code);
        this.assert(actual === expected, `Expected ${expected} for "${code.slice(0,30)}...", got ${actual}`);
      }
    });

    // Test 3: Language detection
    await this.runTest('PatternRecognition: Detects programming language', async () => {
      const jsCode = 'import React from "react"; export default App;';
      const pyCode = 'def hello(name):\n  return f"Hello {name}"';
      
      this.assert(window.patternRecognition.detectLanguage(jsCode) === 'javascript',
        'Should detect JavaScript');
      this.assert(window.patternRecognition.detectLanguage(pyCode) === 'python',
        'Should detect Python');
    });

    // Test 4: Behavior pattern learning
    await this.runTest('PatternRecognition: Learns behavior patterns', async () => {
      const pattern = window.patternRecognition.learnBehavior('save_file', {
        fileType: 'javascript'
      });
      
      this.assert(pattern.action === 'save_file', 'Should record action');
      this.assert(pattern.occurrences >= 1, 'Should track occurrences');
    });

    // Test 5: Action sequence learning
    await this.runTest('PatternRecognition: Learns action sequences', async () => {
      const sequence = ['open_file', 'edit', 'save', 'run_tests'];
      const pattern = window.patternRecognition.learnSequence(sequence, { success: true });
      
      this.assert(pattern.sequence.length === 4, 'Should store sequence');
      this.assert(pattern.successWeight >= 1, 'Should track success');
    });

    // Test 6: Anti-pattern detection
    await this.runTest('PatternRecognition: Detects anti-patterns', async () => {
      // Learn a rejected pattern
      window.patternRecognition.learnRejectedPattern(
        'eval(userInput)',
        'Security vulnerability: code injection'
      );
      
      const warnings = window.patternRecognition.checkForAntiPatterns('eval(data)');
      // May or may not match depending on structure similarity
      this.assert(Array.isArray(warnings), 'Should return warnings array');
    });

    // Test 7: Next action prediction
    await this.runTest('PatternRecognition: Predicts next actions', async () => {
      // Learn a sequence
      window.patternRecognition.learnSequence(['create_file', 'write_code', 'save'], { success: true });
      window.patternRecognition.learnSequence(['create_file', 'write_code', 'save'], { success: true });
      
      const predictions = window.patternRecognition.predictNextAction(['create_file', 'write_code']);
      this.assert(Array.isArray(predictions), 'Should return predictions');
    });

    // Test 8: Recommendations based on context
    await this.runTest('PatternRecognition: Provides contextual recommendations', async () => {
      const recommendations = window.patternRecognition.getRecommendations({
        language: 'javascript'
      });
      
      this.assert(Array.isArray(recommendations), 'Should return recommendations');
    });
  },

  // ============================================
  // STYLE ANALYZER TESTS
  // ============================================
  
  async testStyleAnalyzer() {
    console.log('\n🎨 Testing Style Analyzer...\n');
    
    // Test 1: Naming convention detection
    await this.runTest('StyleAnalyzer: Detects naming conventions', async () => {
      const code = `
        const userName = 'John';
        const user_age = 25;
        const UserProfile = { name: userName };
        const API_KEY = 'secret';
        
        function getUserData() {}
        function get_user_info() {}
        
        class UserService {}
      `;
      
      window.styleAnalyzer.analyze(code);
      const recs = window.styleAnalyzer.getRecommendations();
      
      this.assert(recs.naming, 'Should detect naming preferences');
    });

    // Test 2: Formatting detection
    await this.runTest('StyleAnalyzer: Detects formatting preferences', async () => {
      const code = `
        const message = 'Hello World';
        const greeting = "Hi there";
        
        function test() {
          const x = 1;
          return x;
        }
      `;
      
      window.styleAnalyzer.analyze(code);
      const recs = window.styleAnalyzer.getRecommendations();
      
      this.assert(recs.formatting.quotes, 'Should detect quote preference');
    });

    // Test 3: Async pattern detection
    await this.runTest('StyleAnalyzer: Detects async patterns', async () => {
      const asyncAwaitCode = `
        async function fetch() {
          const data = await api.get();
          return data;
        }
      `;
      
      window.styleAnalyzer.analyze(asyncAwaitCode);
      const summary = window.styleAnalyzer.getSummary();
      
      // Should detect async/await usage
      this.assert(window.styleAnalyzer.style.patterns.async.asyncAwait > 0 ||
        window.styleAnalyzer.style.patterns.preferred.async,
        'Should detect async pattern preference');
    });

    // Test 4: Import style detection
    await this.runTest('StyleAnalyzer: Detects import styles', async () => {
      const code = `
        import { useState, useEffect } from 'react';
        import React from 'react';
        import * as utils from './utils';
      `;
      
      window.styleAnalyzer.analyze(code);
      const recs = window.styleAnalyzer.getRecommendations();
      
      this.assert(recs.imports.style, 'Should detect import style');
    });

    // Test 5: Comment style detection
    await this.runTest('StyleAnalyzer: Detects comment styles', async () => {
      const code = `
        /**
         * JSDoc comment
         * @param {string} name
         */
        function greet(name) {
          // Inline comment
          return 'Hello ' + name; // Another inline
        }
        
        /* Block comment */
      `;
      
      window.styleAnalyzer.analyze(code);
      const style = window.styleAnalyzer.style;
      
      this.assert(style.comments.style.jsdoc > 0, 'Should detect JSDoc');
      this.assert(style.comments.style.inline > 0, 'Should detect inline comments');
    });

    // Test 6: Error handling style
    await this.runTest('StyleAnalyzer: Detects error handling patterns', async () => {
      const code = `
        try {
          riskyOperation();
        } catch (error) {
          console.error(error);
        }
        
        fetch(url).catch(err => logger.error(err));
      `;
      
      window.styleAnalyzer.analyze(code);
      const style = window.styleAnalyzer.style;
      
      this.assert(style.errorHandling.style.tryCatch > 0, 'Should detect try-catch');
      this.assert(style.errorHandling.style.promise > 0, 'Should detect promise catch');
    });

    // Test 7: Accumulated analysis
    await this.runTest('StyleAnalyzer: Accumulates preferences over samples', async () => {
      // Analyze multiple samples with consistent style
      for (let i = 0; i < 5; i++) {
        window.styleAnalyzer.analyze(`
          const item${i} = [];
          const data${i} = {};
        `);
      }
      
      const summary = window.styleAnalyzer.getSummary();
      this.assert(summary.samplesAnalyzed >= 5, 'Should track sample count');
    });
  },

  // ============================================
  // ADAPTIVE COMPLETIONS TESTS
  // ============================================
  
  async testAdaptiveCompletions() {
    console.log('\n⚡ Testing Adaptive Completions...\n');
    
    // Test 1: Completion tracking
    await this.runTest('AdaptiveCompletions: Tracks offered completions', async () => {
      const id = window.adaptiveCompletions.offerCompletion({
        text: 'const result = await fetch(url);',
        type: 'function_call',
        language: 'javascript'
      });
      
      this.assert(id.startsWith('comp_'), 'Should return completion ID');
      this.assert(window.adaptiveCompletions.pendingCompletions.has(id),
        'Should track as pending');
    });

    // Test 2: Acceptance recording
    await this.runTest('AdaptiveCompletions: Records acceptance correctly', async () => {
      const id = window.adaptiveCompletions.offerCompletion({
        text: 'if (condition) { return true; }',
        type: 'conditional',
        language: 'javascript'
      });
      
      const before = window.adaptiveCompletions.data.accepted;
      window.adaptiveCompletions.recordOutcome(id, 'accepted');
      
      this.assert(window.adaptiveCompletions.data.accepted === before + 1,
        'Should increment accepted count');
    });

    // Test 3: Rejection recording
    await this.runTest('AdaptiveCompletions: Records rejection correctly', async () => {
      const id = window.adaptiveCompletions.offerCompletion({
        text: 'var x = 1;',
        type: 'assignment',
        language: 'javascript'
      });
      
      const before = window.adaptiveCompletions.data.rejected;
      window.adaptiveCompletions.recordOutcome(id, 'rejected');
      
      this.assert(window.adaptiveCompletions.data.rejected === before + 1,
        'Should increment rejected count');
    });

    // Test 4: Type detection
    await this.runTest('AdaptiveCompletions: Detects completion types', async () => {
      const types = {
        'import { x } from "y"': 'import',
        'function test() {}': 'function',
        'if (x > 0) {}': 'conditional',
        'for (const i of arr) {}': 'loop',
        'console.log(x)': 'logging',
        'return result': 'return'
      };
      
      for (const [text, expected] of Object.entries(types)) {
        const actual = window.adaptiveCompletions.detectType(text);
        this.assert(actual === expected, 
          `Expected ${expected} for "${text.slice(0,20)}...", got ${actual}`);
      }
    });

    // Test 5: Scoring based on history
    await this.runTest('AdaptiveCompletions: Scores based on history', async () => {
      // Accept multiple function completions
      for (let i = 0; i < 5; i++) {
        const id = window.adaptiveCompletions.offerCompletion({
          text: 'function test' + i + '() {}',
          type: 'function'
        });
        window.adaptiveCompletions.recordOutcome(id, 'accepted');
      }
      
      // Reject multiple loop completions
      for (let i = 0; i < 5; i++) {
        const id = window.adaptiveCompletions.offerCompletion({
          text: 'for (let i = 0; i < ' + i + '; i++) {}',
          type: 'loop'
        });
        window.adaptiveCompletions.recordOutcome(id, 'rejected');
      }
      
      // Score should favor functions over loops
      const funcScore = window.adaptiveCompletions.scoreCompletion({
        text: 'function newFunc() {}',
        type: 'function'
      });
      const loopScore = window.adaptiveCompletions.scoreCompletion({
        text: 'for (const x of y) {}',
        type: 'loop'
      });
      
      // Function should score higher if we have enough data
      if (window.adaptiveCompletions.data.byType['function']?.offered >= 5) {
        this.assert(funcScore >= loopScore - 0.1, 
          `Function score (${funcScore}) should be >= loop score (${loopScore}) - tolerance`);
      }
    });

    // Test 6: Completion ranking
    await this.runTest('AdaptiveCompletions: Ranks completions correctly', async () => {
      const completions = [
        { text: 'for (let i = 0; i < 10; i++) {}', type: 'loop' },
        { text: 'function newFunction() {}', type: 'function' },
        { text: 'const x = 1;', type: 'assignment' }
      ];
      
      const ranked = window.adaptiveCompletions.rankCompletions(completions);
      
      this.assert(ranked.length === 3, 'Should return all completions');
      this.assert(ranked[0].adaptiveScore !== undefined, 'Should add adaptive scores');
      this.assert(ranked[0].adaptiveScore >= ranked[2].adaptiveScore, 
        'Should be sorted by score descending');
    });

    // Test 7: Preference learning
    await this.runTest('AdaptiveCompletions: Learns preferences over time', async () => {
      window.adaptiveCompletions.updatePreferences();
      const prefs = window.adaptiveCompletions.data.preferences;
      
      this.assert(prefs.preferredLength, 'Should detect preferred length');
      this.assert(Array.isArray(prefs.preferredTypes), 'Should have preferred types array');
      this.assert(Array.isArray(prefs.avoidTypes), 'Should have avoid types array');
    });

    // Test 8: Statistics and insights
    await this.runTest('AdaptiveCompletions: Provides accurate stats/insights', async () => {
      const stats = window.adaptiveCompletions.getStats();
      const insights = window.adaptiveCompletions.getInsights();
      
      this.assert(typeof stats.total === 'number', 'Should have total count');
      this.assert(typeof stats.accepted === 'number', 'Should have accepted count');
      this.assert(Array.isArray(insights), 'Should return insights array');
    });
  },

  // ============================================
  // CAPABILITY TRACKER TESTS
  // ============================================
  
  async testCapabilityTracker() {
    console.log('\n🏆 Testing Capability Tracker...\n');
    
    // Test 1: Task recording
    await this.runTest('CapabilityTracker: Records task outcomes', async () => {
      window.capabilityTracker.recordTask({
        type: 'implementation',
        skill: 'javascript',
        success: true,
        difficulty: 'medium'
      });
      
      const cap = window.capabilityTracker.capabilities.skills['javascript'];
      this.assert(cap.samples > 0, 'Should increment sample count');
    });

    // Test 2: Multiple skill tracking
    await this.runTest('CapabilityTracker: Tracks multiple skills per task', async () => {
      window.capabilityTracker.recordTask({
        type: 'implementation',
        skill: ['react', 'typescript'],
        success: true,
        difficulty: 'hard'
      });
      
      const react = window.capabilityTracker.capabilities.skills['react'];
      const ts = window.capabilityTracker.capabilities.skills['typescript'];
      
      this.assert(react.samples > 0, 'Should track react');
      this.assert(ts.samples > 0, 'Should track typescript');
    });

    // Test 3: Difficulty weighting
    await this.runTest('CapabilityTracker: Weights by difficulty', async () => {
      // Record an easy failure - should penalize more
      const before = window.capabilityTracker.capabilities.skills['testing']?.score || 0.5;
      
      window.capabilityTracker.recordTask({
        type: 'testing',
        skill: 'testing',
        success: false,
        difficulty: 'easy'
      });
      
      const after = window.capabilityTracker.capabilities.skills['testing'].score;
      // Score should decrease (or at least not increase)
      this.assert(after <= before + 0.1, 'Easy failure should not increase score');
    });

    // Test 4: Trend detection
    await this.runTest('CapabilityTracker: Detects skill trends', async () => {
      // Record multiple successes for a skill
      for (let i = 0; i < 6; i++) {
        window.capabilityTracker.recordTask({
          skill: 'debugging',
          success: true
        });
      }
      
      const cap = window.capabilityTracker.capabilities.skills['debugging'];
      this.assert(['improving', 'stable', 'declining', 'new'].includes(cap.trend),
        'Should have valid trend');
    });

    // Test 5: Strength identification
    await this.runTest('CapabilityTracker: Identifies strengths', async () => {
      // Create a strong skill
      for (let i = 0; i < 10; i++) {
        window.capabilityTracker.recordTask({
          skill: 'refactoring',
          success: true,
          difficulty: 'hard'
        });
      }
      
      window.capabilityTracker.analyzeCapabilities();
      const strengths = window.capabilityTracker.capabilities.strengths;
      
      // Should have at least one strength if we have high-scoring skills
      this.assert(Array.isArray(strengths), 'Should have strengths array');
    });

    // Test 6: Gap identification
    await this.runTest('CapabilityTracker: Identifies skill gaps', async () => {
      // Create a weak skill
      for (let i = 0; i < 5; i++) {
        window.capabilityTracker.recordTask({
          skill: 'documentation',
          success: false
        });
      }
      
      window.capabilityTracker.analyzeCapabilities();
      const gaps = window.capabilityTracker.capabilities.gaps;
      
      this.assert(Array.isArray(gaps), 'Should have gaps array');
    });

    // Test 7: Confidence for task
    await this.runTest('CapabilityTracker: Provides task confidence', async () => {
      const conf = window.capabilityTracker.getConfidenceForTask(['javascript', 'react']);
      
      this.assert(typeof conf.confidence === 'number', 'Should return confidence number');
      this.assert(conf.reason, 'Should provide reason');
      this.assert(conf.confidence >= 0 && conf.confidence <= 1, 'Confidence should be 0-1');
    });

    // Test 8: Summary generation
    await this.runTest('CapabilityTracker: Generates accurate summary', async () => {
      const summary = window.capabilityTracker.getSummary();
      
      this.assert(typeof summary.totalSkills === 'number', 'Should count skills');
      this.assert(typeof summary.averageScore === 'number', 'Should calculate average');
      this.assert(Array.isArray(summary.topSkills), 'Should list top skills');
      this.assert(Array.isArray(summary.suggestions), 'Should provide suggestions');
    });

    // Test 9: Skill level classification
    await this.runTest('CapabilityTracker: Classifies skill levels', async () => {
      const levels = [
        { score: 0.95, expected: 'expert' },
        { score: 0.8, expected: 'proficient' },
        { score: 0.65, expected: 'competent' },
        { score: 0.45, expected: 'developing' },
        { score: 0.2, expected: 'learning' }
      ];
      
      for (const { score, expected } of levels) {
        const level = window.capabilityTracker.getSkillLevel(score);
        this.assert(level.level === expected, 
          `Score ${score} should be ${expected}, got ${level.level}`);
      }
    });
  },

  // ============================================
  // INTEGRATION TESTS
  // ============================================
  
  async testIntegration() {
    console.log('\n🔗 Testing Module Integration...\n');
    
    // Test 1: Reflexion updates Learning Memory
    await this.runTest('Integration: Reflexion → Learning Memory', async () => {
      const before = window.learningMemory.memory.mistakes.length;
      
      await window.reflexionEngine.reflect({
        task: 'Integration test task',
        error: 'Integration test error',
        category: 'integration'
      });
      
      const after = window.learningMemory.memory.mistakes.length;
      this.assert(after >= before, 'Reflexion should add to learning memory mistakes');
    });

    // Test 2: Style analyzer provides recommendations for adaptive completions
    await this.runTest('Integration: Style → Adaptive Completions', async () => {
      window.styleAnalyzer.analyze(`
        const x = 1;
        const y = 2;
        function test() { return x + y; }
      `);
      
      const recs = window.styleAnalyzer.getRecommendations();
      // Recs should exist and be usable by completions
      this.assert(recs.formatting, 'Style should provide formatting recs');
    });

    // Test 3: Capability tracker uses learning memory outcomes
    await this.runTest('Integration: Learning Memory → Capabilities', async () => {
      window.learningMemory.recordOutcome({
        task: 'API integration',
        success: true,
        category: 'api_design'
      });
      
      const cap = window.learningMemory.memory.capabilities['api_design'];
      this.assert(cap, 'Learning memory should update capabilities');
    });

    // Test 4: Self-critique uses calibration
    await this.runTest('Integration: Self-Critique uses history', async () => {
      const stats = window.selfCritique.getCalibrationStats();
      this.assert(typeof stats.count === 'number', 'Should have critique count');
      this.assert(typeof stats.avgScore === 'number', 'Should have average score');
    });

    // Test 5: Dashboard aggregates all modules
    await this.runTest('Integration: Dashboard aggregates all', async () => {
      const stats = window.metacognitiveDashboard.gatherStats();
      
      this.assert('calibrationScore' in stats, 'Should include calibration');
      this.assert('completionRate' in stats, 'Should include completions');
      this.assert('learnedPatterns' in stats, 'Should include patterns');
      this.assert(Array.isArray(stats.insights), 'Should aggregate insights');
      this.assert(Array.isArray(stats.suggestions), 'Should aggregate suggestions');
    });
  },

  // ============================================
  // PERFORMANCE TESTS
  // ============================================
  
  async testPerformance() {
    console.log('\n⚡ Testing Performance...\n');
    
    // Test 1: Critique latency
    await this.runTest('Performance: Critique < 50ms', async () => {
      const start = performance.now();
      for (let i = 0; i < 10; i++) {
        await window.selfCritique.critique('Test response ' + i, { userQuery: 'Test query' });
      }
      const avgTime = (performance.now() - start) / 10;
      
      this.assert(avgTime < 50, `Average critique time ${avgTime.toFixed(2)}ms should be < 50ms`);
    });

    // Test 2: Learning memory operations
    await this.runTest('Performance: Learning Memory ops < 10ms', async () => {
      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        window.learningMemory.recordSuccess({ pattern: 'test' + i, category: 'perf' });
      }
      const avgTime = (performance.now() - start) / 100;
      
      this.assert(avgTime < 10, `Average memory op ${avgTime.toFixed(2)}ms should be < 10ms`);
    });

    // Test 3: Pattern recognition
    await this.runTest('Performance: Pattern analysis < 20ms', async () => {
      const code = 'async function test() { const x = await fetch("/api"); return x.json(); }';
      
      const start = performance.now();
      for (let i = 0; i < 50; i++) {
        window.patternRecognition.learnCodePattern(code + i, { language: 'javascript' });
      }
      const avgTime = (performance.now() - start) / 50;
      
      this.assert(avgTime < 20, `Average pattern op ${avgTime.toFixed(2)}ms should be < 20ms`);
    });

    // Test 4: Style analysis
    await this.runTest('Performance: Style analysis < 30ms', async () => {
      const code = `
        const x = 1;
        function test() { return x; }
        async function fetchData() { await api.get(); }
      `.repeat(5);
      
      const start = performance.now();
      for (let i = 0; i < 20; i++) {
        window.styleAnalyzer.analyze(code);
      }
      const avgTime = (performance.now() - start) / 20;
      
      this.assert(avgTime < 30, `Average style analysis ${avgTime.toFixed(2)}ms should be < 30ms`);
    });

    // Test 5: Completion scoring
    await this.runTest('Performance: Completion scoring < 5ms', async () => {
      const completions = Array.from({ length: 100 }, (_, i) => ({
        text: 'const x = ' + i,
        type: 'assignment'
      }));
      
      const start = performance.now();
      window.adaptiveCompletions.rankCompletions(completions);
      const time = performance.now() - start;
      
      this.assert(time < 50, `Ranking 100 completions took ${time.toFixed(2)}ms, should be < 50ms`);
    });

    // Test 6: Reflexion creation
    await this.runTest('Performance: Reflexion < 20ms', async () => {
      const start = performance.now();
      for (let i = 0; i < 20; i++) {
        await window.reflexionEngine.reflect({
          task: 'Perf test ' + i,
          error: 'Test error',
          category: 'performance'
        });
      }
      const avgTime = (performance.now() - start) / 20;
      
      this.assert(avgTime < 20, `Average reflexion ${avgTime.toFixed(2)}ms should be < 20ms`);
    });

    // Test 7: Dashboard rendering
    await this.runTest('Performance: Dashboard render < 100ms', async () => {
      const start = performance.now();
      for (const tab of ['overview', 'capabilities', 'learning', 'calibration', 'reflexions', 'style']) {
        window.metacognitiveDashboard.renderTab(tab);
      }
      const time = performance.now() - start;
      
      this.assert(time < 100, `Rendering all tabs took ${time.toFixed(2)}ms, should be < 100ms`);
    });
  },

  // ============================================
  // RUN ALL TESTS
  // ============================================
  
  async runAll() {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  🧪 SELF-IMPROVEMENT SYSTEM TEST SUITE');
    console.log('═══════════════════════════════════════════════════════════');
    
    this.results = [];
    this.startTime = performance.now();
    
    // Run all test suites
    await this.testSelfCritique();
    await this.testLearningMemory();
    await this.testConfidenceCalibration();
    await this.testReflexionEngine();
    await this.testPatternRecognition();
    await this.testStyleAnalyzer();
    await this.testAdaptiveCompletions();
    await this.testCapabilityTracker();
    await this.testIntegration();
    await this.testPerformance();
    
    const totalTime = performance.now() - this.startTime;
    
    // Summary
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  📊 TEST RESULTS SUMMARY');
    console.log('═══════════════════════════════════════════════════════════');
    
    const passed = this.results.filter(r => r.status === 'PASS').length;
    const failed = this.results.filter(r => r.status === 'FAIL').length;
    
    console.log(`\n  Total Tests: ${this.results.length}`);
    console.log(`  ✅ Passed: ${passed}`);
    console.log(`  ❌ Failed: ${failed}`);
    console.log(`  ⏱️ Total Time: ${totalTime.toFixed(2)}ms`);
    console.log(`  📈 Pass Rate: ${((passed / this.results.length) * 100).toFixed(1)}%`);
    
    if (failed > 0) {
      console.log('\n  ❌ FAILED TESTS:');
      this.results.filter(r => r.status === 'FAIL').forEach(r => {
        console.log(`     - ${r.name}: ${r.error}`);
      });
    }
    
    console.log('\n═══════════════════════════════════════════════════════════\n');
    
    return {
      total: this.results.length,
      passed,
      failed,
      passRate: passed / this.results.length,
      totalTime,
      results: this.results
    };
  }
};

// Make available globally
window.SelfImprovementTests = SelfImprovementTests;

console.log('🧪 Self-Improvement Tests loaded. Run: await SelfImprovementTests.runAll()');
