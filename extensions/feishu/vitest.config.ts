import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 测试环境
    environment: 'node',
    
    // 测试文件匹配模式
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    
    // 测试超时时间（毫秒）
    testTimeout: 10000,
    
    // 每个测试的超时时间
    hookTimeout: 5000,
    
    // 覆盖率配置
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'node_modules'],
      thresholds: {
        global: {
          statements: 80,
          branches: 70,
          functions: 80,
          lines: 80,
        },
      },
    },
    
    // 报告配置
    reporters: ['verbose'],
    
    // 模拟配置
    fakeTimers: {
      toFake: ['setTimeout', 'clearTimeout', 'Date'],
    },
  },
  
  // 路径别名
  resolve: {
    alias: {
      '@': './src',
    },
  },
});
