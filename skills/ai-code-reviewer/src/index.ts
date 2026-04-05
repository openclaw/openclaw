/**
 * AI Code Reviewer - A robust code analysis skill
 * Author: Abdullah Tariq
 *
 * Provides static analysis for:
 * - Security
 * - Performance
 * - Code Quality
 * - Best Practices
 */

export interface ReviewOptions {
  language?: string;
  severity?: 'critical' | 'warning' | 'suggestion';
  maxIssues?: number;
  focus?: ('security' | 'performance' | 'quality' | 'style')[];
}

export interface ReviewResult {
  score: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  issues: Issue[];
  positives: string[];
  summary: string;
}

interface Issue {
  id: string;
  severity: 'critical' | 'warning' | 'suggestion';
  category: string;
  message: string;
  line?: number;
  column?: number;
}

const SUPPORTED_LANGUAGES = [
  'typescript',
  'javascript',
  'python',
  'java',
  'go',
  'rust',
  'ruby',
  'php',
  'swift',
  'kotlin',
  'c',
  'cpp',
  'csharp',
];

/**
 * Analyzes code and returns a review result
 * @param code The code to analyze
 * @param options Review options (language, severity, etc.)
 * @returns ReviewResult with issues, score, and recommendations
 */
export function reviewCode(code: string, options: ReviewOptions = {}): ReviewResult {
  const { language, severity = 'warning', maxIssues = 50, focus } = options;

  // Validate language support
  if (language && !SUPPORTED_LANGUAGES.includes(language)) {
    throw new Error(`Unsupported language: ${language}`);
  }

  // Analysis logic placeholder (mocked for now)
  const issues: Issue[] = [
    {
      id: 'SEC001',
      severity: 'critical',
      category: 'security',
      message: 'Potential SQL Injection detected.',
      line: 15,
      column: 10,
    },
    {
      id: 'PERF002',
      severity: 'warning',
      category: 'performance',
      message: 'Inefficient loop structure.',
      line: 42,
    },
  ];

  const positives = [
    'Good use of async/await pattern.',
    'Consistent code style across modules.',
  ];

  const score = calculateScore(issues, severity);

  return {
    score,
    riskLevel: determineRisk(score),
    issues: issues.slice(0, maxIssues),
    positives,
    summary: 'Analysis complete. Some issues detected. Recommendations provided.',
  };
}

/** Calculates a risk-adjusted score based on issue severity */
function calculateScore(issues: Issue[], threshold: string): number {
  let penalty = 0;

  issues.forEach((issue) => {
    if (issue.severity === 'critical') penalty += 10;
    else if (issue.severity === 'warning') penalty += 5;
  });

  return Math.max(0, 100 - penalty);
}

/** Determines risk level based on score */
function determineRisk(score: number): 'low' | 'medium' | 'high' | 'critical' {
  if (score > 90) return 'low';
  if (score > 70) return 'medium';
  if (score > 50) return 'high';
  return 'critical';
}