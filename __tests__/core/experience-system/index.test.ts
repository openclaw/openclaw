import { ExperienceSystem } from '../../../src/core/experience-system';
import { ExperienceRecord } from '../../../src/core/experience-system/types';
import { ExperienceStorage } from '../../../src/core/experience-system/storage';
import { ExperienceAbstraction } from '../../../src/core/experience-system/abstraction';
import { ExperienceFilter } from '../../../src/core/experience-system/filter';

describe('ExperienceSystem', () => {
  let experienceSystem: ExperienceSystem;
  let mockStorage: jest.Mocked<ExperienceStorage>;
  let mockAbstraction: jest.Mocked<ExperienceAbstraction>;
  let mockFilter: jest.Mocked<ExperienceFilter>;

  beforeEach(() => {
    mockStorage = {
      save: jest.fn(),
      getAll: jest.fn(),
      get: jest.fn(),
    } as unknown as jest.Mocked<ExperienceStorage>;

    mockAbstraction = {
      generate: jest.fn(),
    } as unknown as jest.Mocked<ExperienceAbstraction>;

    mockFilter = {
      apply: jest.fn(),
    } as unknown as jest.Mocked<ExperienceFilter>;

    // Mock the constructor to use our mocks
    jest.spyOn(ExperienceStorage.prototype, 'constructor').mockImplementation(() => {
      Object.assign(this, mockStorage);
    });

    jest.spyOn(ExperienceAbstraction.prototype, 'constructor').mockImplementation(() => {
      Object.assign(this, mockAbstraction);
    });

    jest.spyOn(ExperienceFilter.prototype, 'constructor').mockImplementation(() => {
      Object.assign(this, mockFilter);
    });

    experienceSystem = new ExperienceSystem();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('recordExperience', () => {
    it('should save experience to storage', async () => {
      const mockSession: ExperienceRecord = {
        id: '1',
        context: { action: 'test' },
        timestamp: new Date(),
      };

      await experienceSystem.recordExperience(mockSession);

      expect(mockStorage.save).toHaveBeenCalledWith(mockSession);
    });
  });

  describe('querySimilarExperiences', () => {
    it('should query similar experiences with default limit', async () => {
      const mockExperiences: ExperienceRecord[] = [
        { id: '1', context: { action: 'test' }, timestamp: new Date() },
        { id: '2', context: { action: 'test' }, timestamp: new Date() },
      ];

      mockStorage.getAll.mockResolvedValue(mockExperiences);
      mockFilter.apply.mockReturnValue(mockExperiences);

      const result = await experienceSystem.querySimilarExperiences({ action: 'test' });

      expect(mockStorage.getAll).toHaveBeenCalled();
      expect(mockFilter.apply).toHaveBeenCalledWith(mockExperiences, { action: 'test' });
      expect(result).toHaveLength(2);
    });

    it('should query similar experiences with custom limit', async () => {
      const mockExperiences: ExperienceRecord[] = [
        { id: '1', context: { action: 'test' }, timestamp: new Date() },
        { id: '2', context: { action: 'test' }, timestamp: new Date() },
        { id: '3', context: { action: 'test' }, timestamp: new Date() },
      ];

      mockStorage.getAll.mockResolvedValue(mockExperiences);
      mockFilter.apply.mockReturnValue(mockExperiences);

      const result = await experienceSystem.querySimilarExperiences({ action: 'test' }, 2);

      expect(result).toHaveLength(2);
    });
  });

  describe('abstractPatterns', () => {
    it('should generate patterns from experiences', async () => {
      const mockExperiences: ExperienceRecord[] = [
        { id: '1', context: { action: 'test' }, timestamp: new Date() },
      ];

      const mockPatterns = { pattern: 'test-pattern' };
      mockAbstraction.generate.mockResolvedValue(mockPatterns);

      const result = await experienceSystem.abstractPatterns(mockExperiences);

      expect(mockAbstraction.generate).toHaveBeenCalledWith(mockExperiences);
      expect(result).toEqual(mockPatterns);
    });
  });

  describe('filterExperiences', () => {
    it('should filter experiences', () => {
      const mockExperiences: ExperienceRecord[] = [
        { id: '1', context: { action: 'test' }, timestamp: new Date() },
      ];

      const filteredExperiences = [mockExperiences[0]];
      mockFilter.apply.mockReturnValue(filteredExperiences);

      const result = experienceSystem.filterExperiences(mockExperiences);

      expect(mockFilter.apply).toHaveBeenCalledWith(mockExperiences);
      expect(result).toEqual(filteredExperiences);
    });
  });

  describe('shareExperience', () => {
    it('should share experience successfully', async () => {
      const mockExperience: ExperienceRecord = {
        id: '1',
        context: { action: 'test' },
        timestamp: new Date(),
      };

      mockStorage.get.mockResolvedValue(mockExperience);

      await expect(experienceSystem.shareExperience('1', 'user@example.com')).resolves.toBeUndefined();

      expect(mockStorage.get).toHaveBeenCalledWith('1');
    });

    it('should throw error when experience not found', async () => {
      mockStorage.get.mockResolvedValue(null);

      await expect(experienceSystem.shareExperience('nonexistent', 'user@example.com')).rejects.toThrow(
        'Experience with id nonexistent not found'
      );
    });
  });
});